import { Pool, Dispatcher, errors } from "undici";

// ==========================================
// CONFIGURATION TYPES
// ==========================================

export interface CallPoolOptions {
    /** Base URL for all requests (e.g. "https://api.example.com") */
    baseUrl: string;

    /** Concurrency Configuration (Socket/Queue) */
    concurrency?: {
        limit?: number; // Default: 1
    };

    /** Static Configuration (Contractual Rate Limit) */
    rateLimit?: {
        /** Minimum time between requests. If "auto", requires `quota`. */
        minTime?: number | "auto";
        /** Defined quota (e.g. 100 req / 60000ms) */
        quota?: { max: number; window: number };
    };

    /** * Dynamic Configuration (Adaptive Throttling / Network Awareness).
     * Manages CONCURRENCY based on actual server latency.
     */
    adaptive?: {
        /** Enables dynamic throttling. Default: false */
        enabled?: boolean;

        /**
         * true: Measures only TTFB (Time To First Byte). Great for variable payloads.
         * false: Measures complete download.
         * Default: true
         */
        useTTFB?: boolean;

        /**
         * Duration threshold (ms). Requests faster than this are read as a
         * "server has headroom" signal and trigger a concurrency increase.
         * They are excluded from the baseline so cache hits can't corrupt it.
         * Default: 100ms
         */
        ignoreBelow?: number;

        /**
         * Congestion threshold multiplier. If latency > baseline * congestionRatio,
         * the request counts as congestion and (after `breachLimit` confirmations)
         * concurrency is reduced.
         * Default: 2.0
         */
        congestionRatio?: number;

        /**
         * How many consecutive times congestion must be detected before slowing down.
         * Filters outliers (e.g. GC spikes or isolated packet loss).
         * Default: 2
         */
        breachLimit?: number;

        /** [AIMD] Additive Increase: How many CONNECTIONS to add in recovery. Default: 1 */
        increaseStep?: number;

        /** [AIMD] Multiplicative Decrease: Reduction factor (0-1) for concurrency in congestion. Default: 0.9 */
        decreaseFactor?: number;

        /** Lower bound for concurrency. The algorithm will never go below this. Default: 1 */
        minConcurrency?: number;

        /**
         * Starting concurrency for the adaptive algorithm (slow-start).
         * Must be between `minConcurrency` and `concurrency.limit`.
         * Default: `concurrency.limit`
         */
        initialConcurrency?: number;
    };

    /** Retry Configuration (Resilience) */
    retry?: {
        /** Total number of attempts, including the initial request. Default: 3 */
        maxAttempts?: number;
        delay?: number;
        factor?: number;
        /**
         * Upper bound (ms) for the wait honored from a 429 Retry-After header.
         * Prevents a misbehaving server from parking a concurrency slot for
         * hours. Default: 60000 (60s)
         */
        maxRetryAfter?: number;
    };

    /** Undici Network Options */
    network?: {
        timeout?: number;
        defaultHeaders?: Record<string, string>;
    };
}

export interface RequestOptions extends Omit<Dispatcher.RequestOptions, "origin" | "path" | "method" | "body" | "headers" | "signal"> {
    method?: Dispatcher.HttpMethod;
    priority?: number;
    body?: string | Buffer | Uint8Array | object | null;
    headers?: Record<string, string>;
    /**
     * Narrowed to AbortSignal only (undici also accepts a legacy EventEmitter
     * shape, but the retry loop's abort guards would not see it).
     */
    signal?: AbortSignal | null;
}

// ==========================================
// TYPED ERROR
// ==========================================

export interface CallPoolErrorDetails {
    statusCode?: number;
    body?: string;
    headers?: Record<string, string | string[] | undefined>;
    retryable?: boolean;
    retryAfterMs?: number;
}

/**
 * Error thrown for HTTP-level failures (4xx/5xx, rate limits, invalid JSON).
 * Network-level failures (DNS, connection reset, timeouts) propagate as the
 * original undici errors instead.
 */
export class CallPoolError extends Error {
    /** HTTP status code of the failing response */
    public readonly statusCode?: number;
    /** Raw response body */
    public readonly body?: string;
    /** Response headers (Set-Cookie is redacted) */
    public readonly headers?: Record<string, string | string[] | undefined>;
    /** Whether the pool retries this failure (subject to `retry.maxAttempts`) */
    public readonly retryable: boolean;
    /** Parsed and capped Retry-After wait (ms), present on 429 responses */
    public readonly retryAfterMs?: number;

    constructor(message: string, details: CallPoolErrorDetails = {}) {
        super(message);
        this.name = "CallPoolError";
        this.statusCode = details.statusCode;
        this.body = details.body;
        this.headers = details.headers;
        this.retryable = details.retryable ?? false;
        this.retryAfterMs = details.retryAfterMs;
    }
}

// ==========================================
// INTERNAL SCHEDULER
// ==========================================

/** Live snapshot of the pool's scheduling state; see {@link CallPool.getStats}. */
export interface CallPoolStats {
    /** Jobs waiting in the priority queue */
    queued: number;
    /** Jobs currently executing (a retrying request still occupies its slot) */
    running: number;
    /** Current concurrency limit (dynamically tuned when adaptive is enabled) */
    concurrency: number;
}

interface ScheduledJob {
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

interface PriorityBucket {
    jobs: Array<ScheduledJob | undefined>;
    head: number;
}

interface RateWaiter {
    resolve: () => void;
    reject: (reason: unknown) => void;
}

class PoolClosedError extends Error {
    constructor() {
        super("[CallPool] Pool is closed");
        this.name = "Error";
    }
}

const PRIORITY_LEVELS = 10;
const PRIORITY_BUCKET_COMPACT_AT = 1024;
const RATE_QUEUE_COMPACT_AT = 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Serializes permission to start individual HTTP attempts. Unlike the request
 * scheduler, this gate is entered again for every retry so contractual limits
 * count actual upstream traffic rather than logical jobs.
 */
class RateGate {
    private readonly minTime: number;
    private readonly quota: { max: number; window: number } | null;
    private readonly epoch = performance.now();
    private readonly waiters: Array<RateWaiter | undefined> = [];

    private head = 0;
    private tokens: number;
    private windowIndex = 0;
    private lastStartAt = -Infinity;
    private wakeTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(options: { minTime: number; quota?: { max: number; window: number } }) {
        this.minTime = options.minTime;
        this.quota = options.quota ?? null;
        this.tokens = this.quota?.max ?? Infinity;
    }

    acquire(): Promise<void> {
        if (this.stopped) return Promise.reject(new PoolClosedError());
        return new Promise<void>((resolve, reject) => {
            this.waiters.push({ resolve, reject });
            this.dispatch();
        });
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.clearWakeTimer();

        const closed = new PoolClosedError();
        for (let index = this.head; index < this.waiters.length; index++) {
            this.waiters[index]?.reject(closed);
        }
        this.waiters.length = 0;
        this.head = 0;
    }

    private dispatch(): void {
        while (!this.stopped && this.head < this.waiters.length) {
            const wait = this.startDelay(performance.now());
            if (wait > 0) return this.wake(wait);

            const waiter = this.takeNext();
            if (!waiter) return;
            this.lastStartAt = performance.now();
            this.tokens--;
            waiter.resolve();
        }
    }

    private startDelay(now: number): number {
        const spacingWait = this.lastStartAt + this.minTime - now;
        return Math.max(spacingWait, this.quotaWait(now), 0);
    }

    private quotaWait(now: number): number {
        if (!this.quota) return 0;

        const elapsedWindows = Math.floor((now - this.epoch) / this.quota.window);
        if (elapsedWindows > this.windowIndex) {
            this.windowIndex = elapsedWindows;
            this.tokens = this.quota.max;
        }

        if (this.tokens > 0) return 0;
        return this.epoch + (this.windowIndex + 1) * this.quota.window - now;
    }

    private takeNext(): RateWaiter | undefined {
        const waiter = this.waiters[this.head];
        this.waiters[this.head] = undefined;
        this.head++;

        if (this.head === this.waiters.length) {
            this.waiters.length = 0;
            this.head = 0;
        } else if (this.head >= RATE_QUEUE_COMPACT_AT && this.head * 2 >= this.waiters.length) {
            this.waiters.splice(0, this.head);
            this.head = 0;
        }

        return waiter;
    }

    private wake(delayMs: number): void {
        if (this.wakeTimer) return;
        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.dispatch();
        }, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    }

    private clearWakeTimer(): void {
        if (!this.wakeTimer) return;
        clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
    }
}

/**
 * In-process logical-job scheduler: mutable concurrency semaphore and FIFO
 * priority buckets (0 runs first). Rate constraints live in RateGate because
 * they apply to every HTTP attempt, including retries.
 *
 * Job starts are driven by completions with no polling. The queue is unbounded
 * by design: backpressure belongs to the caller.
 */
class RequestScheduler {
    private maxConcurrent: number;

    private readonly queues: PriorityBucket[] = Array.from({ length: PRIORITY_LEVELS }, () => ({ jobs: [], head: 0 }));
    private queuedCount = 0;
    private runningCount = 0;

    private stopped = false;
    private onDrained: (() => void) | null = null;

    constructor(options: { maxConcurrent: number }) {
        this.maxConcurrent = options.maxConcurrent;
    }

    get queued(): number {
        return this.queuedCount;
    }

    get running(): number {
        return this.runningCount;
    }

    schedule<T>(priority: number, task: () => Promise<T>): Promise<T> {
        if (this.stopped) return Promise.reject(new Error("[CallPool] Pool is closed"));
        return new Promise<T>((resolve, reject) => {
            this.queues[priority].jobs.push({ task, resolve: resolve as (value: unknown) => void, reject });
            this.queuedCount++;
            this.dispatch();
        });
    }

    setMaxConcurrent(limit: number): void {
        this.maxConcurrent = limit;
        this.dispatch();
    }

    /** Rejects every queued job and resolves once in-flight jobs have settled. */
    stop(): Promise<void> {
        this.stopped = true;

        const closed = new PoolClosedError();
        for (const bucket of this.queues) {
            for (let index = bucket.head; index < bucket.jobs.length; index++) {
                bucket.jobs[index]?.reject(closed);
            }
            bucket.jobs = [];
            bucket.head = 0;
        }
        this.queuedCount = 0;

        if (this.runningCount === 0) return Promise.resolve();
        return new Promise(resolve => {
            this.onDrained = resolve;
        });
    }

    private dispatch(): void {
        while (this.runningCount < this.maxConcurrent && this.queuedCount > 0) {
            this.runNext();
        }
    }

    private runNext(): void {
        const job = this.takeNext();
        if (!job) return;

        this.runningCount++;
        job.task().then(job.resolve, job.reject).finally(() => this.onJobSettled());
    }

    private takeNext(): ScheduledJob | undefined {
        for (const bucket of this.queues) {
            if (bucket.head >= bucket.jobs.length) continue;

            const job = bucket.jobs[bucket.head];
            bucket.jobs[bucket.head] = undefined;
            bucket.head++;
            this.queuedCount--;

            if (bucket.head === bucket.jobs.length) {
                bucket.jobs = [];
                bucket.head = 0;
            } else if (bucket.head >= PRIORITY_BUCKET_COMPACT_AT && bucket.head * 2 >= bucket.jobs.length) {
                bucket.jobs = bucket.jobs.slice(bucket.head);
                bucket.head = 0;
            }

            return job;
        }
        return undefined;
    }

    private onJobSettled(): void {
        this.runningCount--;
        if (!this.stopped) return this.dispatch();
        if (this.runningCount === 0) this.onDrained?.();
    }

}

// ==========================================
// MAIN CLASS
// ==========================================

export class CallPool {
    private client: Pool;
    private scheduler: RequestScheduler;
    private rateGate: RateGate | null;

    // Runtime Config
    private maxAttempts: number;
    private retryDelay: number;
    private retryFactor: number;
    private maxRetryAfter: number;
    private requestTimeout: number;
    private defaultHeaders: Record<string, string>;

    // Adaptive Config (Flattened for perf)
    private adaptiveEnabled: boolean;
    private useTTFB: boolean;
    private adaptiveIgnoreBelow: number;
    private congestionRatio: number;
    private breachLimit: number;
    private increaseStep: number;
    private decreaseFactor: number;

    // Adaptive Bounds
    private minConcurrency: number;
    private maxConcurrency: number; // Initialized to concurrency.limit

    // Tuning Config
    private readonly tuningDebounce = 250;
    private readonly emaAlpha = 0.2;

    // Adaptive State
    private lastSettingsUpdate: number = -Infinity;
    private pendingUpdateTimer: NodeJS.Timeout | null = null;
    private avgLatency: number = 0;
    private congestionHits: number = 0;

    // Limiter State
    private currentConcurrency: number;
    private closePromise: Promise<void> | null = null;

    /**
     * Creates a pool bound to a single base URL. Validates `options` synchronously
     * and throws before any socket or limiter is created.
     *
     * @param options - Pool configuration; see {@link CallPoolOptions}.
     * @throws {Error} When `options` fails validation (e.g. missing/invalid `baseUrl`,
     * inconsistent adaptive bounds, or `rateLimit.minTime: "auto"` without `quota`).
     */
    constructor(options: CallPoolOptions) {
        this.validateOptions(options);

        const concurrencyLimit = options.concurrency?.limit ?? 1;
        const rateOpts = options.rateLimit;
        const adaptOpts = options.adaptive;

        // --- 1. ADAPTIVE CONFIGURATION ---
        this.adaptiveEnabled = adaptOpts?.enabled ?? false;
        this.useTTFB = adaptOpts?.useTTFB ?? true;
        this.adaptiveIgnoreBelow = adaptOpts?.ignoreBelow ?? 100;
        this.congestionRatio = adaptOpts?.congestionRatio ?? 2.0;
        this.breachLimit = adaptOpts?.breachLimit ?? 2;
        this.increaseStep = adaptOpts?.increaseStep ?? 1;
        this.decreaseFactor = adaptOpts?.decreaseFactor ?? 0.9;

        // Adaptive Bounds Setup (validation guarantees minConcurrency <= limit)
        this.minConcurrency = Math.max(1, Math.floor(adaptOpts?.minConcurrency ?? 1));
        this.maxConcurrency = concurrencyLimit;

        // --- 2. NETWORK & RETRY CONFIGURATION ---
        this.requestTimeout = options.network?.timeout ?? 30_000;
        this.defaultHeaders = options.network?.defaultHeaders ?? {};

        this.maxAttempts = options.retry?.maxAttempts ?? 3;
        this.retryDelay = options.retry?.delay ?? 1000;
        this.retryFactor = options.retry?.factor ?? 2;
        this.maxRetryAfter = options.retry?.maxRetryAfter ?? 60_000;

        // --- 3. CONCURRENCY SETUP ---
        // Adaptive pools may slow-start from initialConcurrency; otherwise
        // start at the maximum.
        this.currentConcurrency = this.adaptiveEnabled ? (adaptOpts?.initialConcurrency ?? this.maxConcurrency) : this.maxConcurrency;

        // --- 4. SETUP UNDICI & SCHEDULER ---
        this.client = this.createClient(options.baseUrl, concurrencyLimit);
        this.scheduler = new RequestScheduler({ maxConcurrent: this.currentConcurrency });
        const minTime = this.computeBaseMinTime(rateOpts);
        this.rateGate = minTime > 0 || rateOpts?.quota ? new RateGate({ minTime, quota: rateOpts?.quota }) : null;
    }

    private computeBaseMinTime(rateOpts: CallPoolOptions["rateLimit"]): number {
        if (rateOpts?.minTime !== "auto") return rateOpts?.minTime ?? 0;
        if (!rateOpts.quota) throw new Error("[CallPool] 'auto' requires 'quota'");
        return Math.ceil(rateOpts.quota.window / rateOpts.quota.max);
    }

    private createClient(baseUrl: string, connections: number): Pool {
        // Undici Pool needs the HARD limit (total sockets available)
        return new Pool(baseUrl, {
            connections,
            pipelining: 1,
            keepAliveTimeout: 10_000,
        });
    }

    private validateOptions(options: CallPoolOptions) {
        if (!options || typeof options.baseUrl !== "string" || options.baseUrl.length === 0) {
            throw new Error("[CallPool] 'baseUrl' is required");
        }

        try {
            new URL(options.baseUrl);
        } catch {
            throw new Error("[CallPool] 'baseUrl' must be a valid URL");
        }

        const concurrencyLimit = options.concurrency?.limit ?? 1;
        if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1) {
            throw new Error("[CallPool] 'concurrency.limit' must be a positive integer");
        }

        const timeout = options.network?.timeout;
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
            throw new Error("[CallPool] 'network.timeout' must be a positive number");
        }

        this.validateRateLimitOptions(options.rateLimit);
        this.validateRetryOptions(options.retry);
        this.validateAdaptiveOptions(options.adaptive, concurrencyLimit);
    }

    private validateRateLimitOptions(rateLimit: CallPoolOptions["rateLimit"]) {
        const quota = rateLimit?.quota;
        if (quota) {
            if (!Number.isInteger(quota.max) || quota.max < 1) {
                throw new Error("[CallPool] 'rateLimit.quota.max' must be a positive integer");
            }
            if (!Number.isFinite(quota.window) || quota.window <= 0) {
                throw new Error("[CallPool] 'rateLimit.quota.window' must be a positive number");
            }
        }

        const minTime = rateLimit?.minTime;
        if (minTime === "auto" && !quota) {
            throw new Error("[CallPool] 'auto' requires 'quota'");
        }
        if (minTime !== undefined && minTime !== "auto" && (!Number.isFinite(minTime) || minTime < 0)) {
            throw new Error("[CallPool] 'rateLimit.minTime' must be a non-negative number or 'auto'");
        }
    }

    private validateRetryOptions(retry: CallPoolOptions["retry"]) {
        if (retry?.maxAttempts !== undefined && (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)) {
            throw new Error("[CallPool] 'retry.maxAttempts' must be a positive integer");
        }
        if (retry?.delay !== undefined && (!Number.isFinite(retry.delay) || retry.delay < 0)) {
            throw new Error("[CallPool] 'retry.delay' must be a non-negative number");
        }
        if (retry?.factor !== undefined && (!Number.isFinite(retry.factor) || retry.factor < 1)) {
            throw new Error("[CallPool] 'retry.factor' must be greater than or equal to 1");
        }
        if (retry?.maxRetryAfter !== undefined && (!Number.isFinite(retry.maxRetryAfter) || retry.maxRetryAfter < 0)) {
            throw new Error("[CallPool] 'retry.maxRetryAfter' must be a non-negative number");
        }
    }

    private validateAdaptiveOptions(adaptive: CallPoolOptions["adaptive"], concurrencyLimit: number) {
        if (!adaptive) return;

        if (adaptive.ignoreBelow !== undefined && (!Number.isFinite(adaptive.ignoreBelow) || adaptive.ignoreBelow < 0)) {
            throw new Error("[CallPool] 'adaptive.ignoreBelow' must be a non-negative number");
        }
        if (adaptive.congestionRatio !== undefined && (!Number.isFinite(adaptive.congestionRatio) || adaptive.congestionRatio <= 0)) {
            throw new Error("[CallPool] 'adaptive.congestionRatio' must be a positive number");
        }
        if (adaptive.breachLimit !== undefined && (!Number.isInteger(adaptive.breachLimit) || adaptive.breachLimit < 1)) {
            throw new Error("[CallPool] 'adaptive.breachLimit' must be a positive integer");
        }
        if (adaptive.increaseStep !== undefined && (!Number.isInteger(adaptive.increaseStep) || adaptive.increaseStep < 1)) {
            throw new Error("[CallPool] 'adaptive.increaseStep' must be a positive integer");
        }
        if (adaptive.decreaseFactor !== undefined && (!Number.isFinite(adaptive.decreaseFactor) || adaptive.decreaseFactor <= 0 || adaptive.decreaseFactor >= 1)) {
            throw new Error("[CallPool] 'adaptive.decreaseFactor' must be greater than 0 and less than 1");
        }
        if (adaptive.minConcurrency !== undefined) {
            if (!Number.isInteger(adaptive.minConcurrency) || adaptive.minConcurrency < 1) {
                throw new Error("[CallPool] 'adaptive.minConcurrency' must be a positive integer");
            }
            if (adaptive.minConcurrency > concurrencyLimit) {
                throw new Error("[CallPool] 'adaptive.minConcurrency' cannot exceed 'concurrency.limit'");
            }
        }
        if (adaptive.initialConcurrency !== undefined) {
            if (!Number.isInteger(adaptive.initialConcurrency) || adaptive.initialConcurrency < 1) {
                throw new Error("[CallPool] 'adaptive.initialConcurrency' must be a positive integer");
            }
            if (adaptive.initialConcurrency > concurrencyLimit) {
                throw new Error("[CallPool] 'adaptive.initialConcurrency' cannot exceed 'concurrency.limit'");
            }
            if (adaptive.initialConcurrency < (adaptive.minConcurrency ?? 1)) {
                throw new Error("[CallPool] 'adaptive.initialConcurrency' cannot be lower than 'adaptive.minConcurrency'");
            }
        }
    }

    /**
     * Schedules an HTTP request through the pool's concurrency/rate limiter, with
     * automatic retries on transient failures.
     *
     * Resolves with the response body parsed as JSON when the response's
     * `Content-Type` is `application/json`, as a string for textual content, or
     * as a byte-preserving Buffer for binary content.
     * HTTP failures (4xx/5xx) reject with {@link CallPoolError}; retryable failures
     * (429, 408, 5xx) are retried up to `retry.maxAttempts`, honoring a capped
     * `Retry-After` wait on 429s. Network-level errors (DNS, connection reset,
     * timeouts) propagate unchanged.
     *
     * @param path - Request path, appended to `baseUrl`.
     * @param options - Per-request overrides. `signal` aborts the request, including
     * any pending retry wait. `priority` (0-9, default 5) sets scheduling order in
     * the limiter's queue; lower values run first.
     * @throws {CallPoolError} On a non-retryable HTTP failure, or after retries are exhausted.
     * @throws {Error} If `priority` is not an integer between 0 and 9.
     */
    public async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
        const { priority = 5, ...reqOpts } = options;
        if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
            throw new Error("[CallPool] 'priority' must be an integer between 0 and 9");
        }
        return this.scheduler.schedule(priority, () => this.executeWithRetry<T>(path, reqOpts));
    }

    private async executeWithRetry<T>(path: string, reqOpts: Omit<RequestOptions, "priority">): Promise<T> {
        const signal = reqOpts.signal instanceof AbortSignal ? reqOpts.signal : undefined;
        let delay = this.retryDelay;

        // Retry waits happen INSIDE the scheduler slot: a retrying logical job
        // keeps occupying its concurrency slot, which acts as natural backpressure.
        for (let attempt = 1; ; attempt++) {
            if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");

            try {
                return await this.executeOnce<T>(path, reqOpts);
            } catch (err) {
                const retryable = this.isRetryableError(err);
                if (!retryable || signal?.aborted || attempt >= this.maxAttempts) throw err;

                // A 429 carries its own (capped) Retry-After wait, honored
                // as-is instead of stacking the backoff delay on top of it.
                const waitMs = err instanceof CallPoolError && err.retryAfterMs !== undefined ? err.retryAfterMs : delay;
                delay *= this.retryFactor;
                await this.sleep(waitMs, signal);
            }
        }
    }

    private isRetryableError(err: unknown): boolean {
        if (err instanceof CallPoolError) return err.retryable;
        if (err instanceof PoolClosedError) return false;
        if (err instanceof errors.InvalidArgumentError || err instanceof errors.InvalidReturnValueError) return false;
        if (err instanceof errors.RequestAbortedError) return false;
        return true;
    }

    private async executeOnce<T>(path: string, reqOpts: Omit<RequestOptions, "priority">): Promise<T> {
        const { body: requestBody, headers: requestHeaders, method = "GET", ...dispatcherOptions } = reqOpts;
        let body = requestBody;
        const headers = { ...this.defaultHeaders, ...requestHeaders } as Record<string, string>;

        if (body && typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
            body = JSON.stringify(body);
            if (!this.hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
        }

        if (this.rateGate) await this.rateGate.acquire();
        const start = performance.now();
        const response = await this.client.request({
            ...dispatcherOptions,
            path,
            method,
            headers,
            body: body as string | Buffer | Uint8Array | null,
            headersTimeout: dispatcherOptions.headersTimeout ?? this.requestTimeout,
            bodyTimeout: dispatcherOptions.bodyTimeout ?? this.requestTimeout,
        });

        // Measure TTFB
        let measuredDuration = 0;
        if (this.useTTFB) measuredDuration = performance.now() - start;

        const statusCode = response.statusCode;
        const resHeaders = this.sanitizeHeaders(response.headers);
        const contentType = this.getHeaderValue(resHeaders["content-type"]);
        const isBinaryResponse = statusCode < 400 && contentType !== undefined && !contentType.includes("application/json") && !this.isTextContentType(contentType);

        // Preserve bytes only for successful binary media. Text, JSON and error
        // bodies keep their established string representation.
        const rawBody = isBinaryResponse ? Buffer.from(await response.body.arrayBuffer()) : await response.body.text();

        // Measure Total (Fallback)
        if (!this.useTTFB) measuredDuration = performance.now() - start;

        // Adaptive Logic Hook
        if (this.adaptiveEnabled && measuredDuration > 0 && statusCode < 400) {
            this.updateThrottleLogic(measuredDuration);
        }

        this.assertSuccess(statusCode, typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"), resHeaders);
        return this.parseBody<T>(statusCode, rawBody, resHeaders);
    }

    private sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
        // Always a fresh copy, so CallPoolError never aliases undici's response
        // object. Set-Cookie is redacted before headers can reach an error
        // serializer (JSON.stringify, pino, winston) and leak session cookies.
        const copy = { ...headers };
        if (copy["set-cookie"] !== undefined) copy["set-cookie"] = "[redacted]";
        return copy;
    }

    private assertSuccess(statusCode: number, rawBody: string, resHeaders: Record<string, string | string[] | undefined>): void {
        // 429 (Rate Limit): retryable, waits Retry-After in the retry loop
        if (statusCode === 429) {
            throw new CallPoolError("Rate Limit Hit (429)", {
                statusCode,
                body: rawBody,
                headers: resHeaders,
                retryable: true,
                retryAfterMs: this.parseRetryAfterMs(resHeaders["retry-after"]),
            });
        }

        // 5xx and 408 are transient, other 4xx are not retried
        if (statusCode >= 500 || statusCode === 408) {
            const message = statusCode === 408 ? "Request Timeout (408)" : `Server Error ${statusCode}`;
            throw new CallPoolError(message, { statusCode, body: rawBody, headers: resHeaders, retryable: true });
        }
        if (statusCode >= 400) {
            throw new CallPoolError(`Client Error ${statusCode}: ${rawBody.substring(0, 200)}`, {
                statusCode,
                body: rawBody,
                headers: resHeaders,
                retryable: false,
            });
        }
    }

    private parseBody<T>(statusCode: number, rawBody: string | Buffer, resHeaders: Record<string, string | string[] | undefined>): T {
        const contentType = this.getHeaderValue(resHeaders["content-type"]);
        if (contentType && contentType.includes("application/json")) {
            const textBody = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
            try {
                return JSON.parse(textBody) as T;
            } catch {
                throw new CallPoolError("Invalid JSON response", { statusCode, body: textBody, headers: resHeaders, retryable: false });
            }
        }

        return rawBody as unknown as T;
    }

    private isTextContentType(contentType: string): boolean {
        const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
        return (
            mediaType.startsWith("text/") ||
            mediaType.endsWith("+json") ||
            mediaType.endsWith("+xml") ||
            mediaType === "application/xml" ||
            mediaType === "application/javascript" ||
            mediaType === "application/x-javascript" ||
            mediaType === "application/x-www-form-urlencoded" ||
            mediaType === "image/svg+xml"
        );
    }

    private hasHeader(headers: Record<string, string>, name: string) {
        const lowerName = name.toLowerCase();
        return Object.keys(headers).some(key => key.toLowerCase() === lowerName);
    }

    private getHeaderValue(value: string | string[] | undefined) {
        return Array.isArray(value) ? value[0] : value;
    }

    private parseRetryAfterMs(value: string | string[] | undefined) {
        // Always clamped to maxRetryAfter: an unbounded Retry-After would park
        // a concurrency slot for its whole duration.
        const defaultMs = Math.min(5000, this.maxRetryAfter);
        const retryAfter = this.getHeaderValue(value);
        if (!retryAfter) return defaultMs;

        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, this.maxRetryAfter);

        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - Date.now()), this.maxRetryAfter);

        return defaultMs;
    }

    private sleep(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise(resolve => {
            if (signal?.aborted) return resolve();

            const onAbort = () => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    // ==========================================
    // ADAPTIVE LOGIC CORE (Single-threshold + stable baseline)
    // ==========================================

    private updateThrottleLogic(duration: number) {
        // Trivially fast request: the server has headroom -> recover.
        // Excluded from the baseline (even at bootstrap) so cache hits can't
        // poison it: a tiny first sample would flag every real request as
        // congestion, and the baseline could never re-learn.
        if (duration < this.adaptiveIgnoreBelow) {
            this.congestionHits = 0;
            this.increaseConcurrency();
            return;
        }

        // First meaningful sample establishes the baseline
        if (this.avgLatency === 0) {
            this.avgLatency = duration;
            return;
        }

        const congestionThreshold = this.avgLatency * this.congestionRatio;

        // Congestion: require breachLimit consecutive samples before reducing.
        // Congested samples are NOT folded into the baseline (prevents drift).
        if (duration > congestionThreshold) {
            this.congestionHits++;
            if (this.congestionHits >= this.breachLimit) {
                this.congestionHits = 0;
                this.reduceConcurrency();
            }
            return;
        }

        // Neutral zone: healthy sample -> learn the baseline and recover.
        this.congestionHits = 0;
        this.avgLatency = this.emaAlpha * duration + (1 - this.emaAlpha) * this.avgLatency;
        this.increaseConcurrency();
    }

    private increaseConcurrency() {
        const next = Math.min(this.currentConcurrency + this.increaseStep, this.maxConcurrency);
        this.applyNewSettings(next);
    }

    private reduceConcurrency() {
        // AIMD decrease: multiplicative factor, but always at least -1 connection.
        const raw = Math.min(this.currentConcurrency * this.decreaseFactor, this.currentConcurrency - 1);
        const next = Math.max(raw, this.minConcurrency);
        this.applyNewSettings(next);
    }

    private applyNewSettings(newConcurrency: number) {
        newConcurrency = Math.floor(newConcurrency);
        if (newConcurrency === this.currentConcurrency) return;

        // Logical state updates immediately so the next decision builds on it.
        this.currentConcurrency = newConcurrency;

        // The actual limiter update is debounced (trailing) to avoid thrashing.
        this.scheduleLimiterUpdate();
    }

    private scheduleLimiterUpdate() {
        const elapsed = performance.now() - this.lastSettingsUpdate;

        if (elapsed >= this.tuningDebounce) {
            this.flushLimiterUpdate();
            return;
        }

        if (this.pendingUpdateTimer) return;

        this.pendingUpdateTimer = setTimeout(() => {
            this.pendingUpdateTimer = null;
            this.flushLimiterUpdate();
        }, this.tuningDebounce - elapsed);
    }

    private flushLimiterUpdate() {
        if (this.pendingUpdateTimer) {
            clearTimeout(this.pendingUpdateTimer);
            this.pendingUpdateTimer = null;
        }

        this.lastSettingsUpdate = performance.now();
        this.scheduler.setMaxConcurrent(this.currentConcurrency);
    }

    /**
     * Returns the pool's current concurrency limit. Under adaptive throttling this
     * is the live, dynamically tuned value and can differ from the static
     * `concurrency.limit` passed to the constructor.
     */
    public getCurrentConcurrency(): number {
        return this.currentConcurrency;
    }

    /**
     * Returns a live snapshot of the pool: queued jobs, in-flight jobs and the
     * current concurrency limit.
     */
    public getStats(): CallPoolStats {
        return {
            queued: this.scheduler.queued,
            running: this.scheduler.running,
            concurrency: this.currentConcurrency,
        };
    }

    /**
     * Shuts the pool down: queued (not yet started) requests are rejected,
     * in-flight requests are awaited, then the underlying sockets are closed.
     * Idempotent and concurrent-safe: every call awaits the same teardown.
     */
    public async close(): Promise<void> {
        this.closePromise ??= this.doClose();
        return this.closePromise;
    }

    private async doClose(): Promise<void> {
        if (this.pendingUpdateTimer) {
            clearTimeout(this.pendingUpdateTimer);
            this.pendingUpdateTimer = null;
        }
        this.rateGate?.stop();
        await this.scheduler.stop();
        await this.client.close();
    }
}
