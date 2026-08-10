import { Pool, Dispatcher } from "undici";
import Bottleneck from "bottleneck";

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
// MAIN CLASS
// ==========================================

export class CallPool {
    private client: Pool;
    private limiter: Bottleneck;

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

        // --- 4. SETUP UNDICI & BOTTLENECK ---
        this.client = this.createClient(options.baseUrl, concurrencyLimit);
        this.limiter = this.createLimiter(this.computeBaseMinTime(rateOpts), rateOpts?.quota);

        this.setupMonitoring();
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

    private createLimiter(minTime: number, quota?: { max: number; window: number }): Bottleneck {
        // Starts with the current adaptive concurrency.
        // No highWater cap: with a bounded queue Bottleneck's BLOCK strategy
        // drops EVERY queued job once the threshold is hit, silently rejecting
        // all pending work. The queue is unbounded by design.
        return new Bottleneck({
            maxConcurrent: this.currentConcurrency,
            minTime,
            reservoir: quota?.max ?? null,
            reservoirRefreshAmount: quota?.max ?? null,
            reservoirRefreshInterval: quota?.window ?? null,
        });
    }

    private setupMonitoring() {
        this.limiter.on("error", err => {
            if (process.env.NODE_ENV !== "production") console.error("[CallPool] Limiter Error:", err);
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
     * `Content-Type` is `application/json`, otherwise with the raw body as a string.
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
        return this.limiter.schedule({ priority }, () => this.executeWithRetry<T>(path, reqOpts));
    }

    private async executeWithRetry<T>(path: string, reqOpts: Omit<RequestOptions, "priority">): Promise<T> {
        const signal = reqOpts.signal instanceof AbortSignal ? reqOpts.signal : undefined;
        let delay = this.retryDelay;

        // Retry waits happen INSIDE the limiter slot: a retrying request keeps
        // occupying its concurrency slot, which acts as natural backpressure.
        for (let attempt = 1; ; attempt++) {
            if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");

            try {
                return await this.executeOnce<T>(path, reqOpts);
            } catch (err) {
                const retryable = err instanceof CallPoolError ? err.retryable : true;
                if (!retryable || signal?.aborted || attempt >= this.maxAttempts) throw err;

                // A 429 carries its own (capped) Retry-After wait, honored
                // as-is instead of stacking the backoff delay on top of it.
                const waitMs = err instanceof CallPoolError && err.retryAfterMs !== undefined ? err.retryAfterMs : delay;
                delay *= this.retryFactor;
                await this.sleep(waitMs, signal);
            }
        }
    }

    private async executeOnce<T>(path: string, reqOpts: Omit<RequestOptions, "priority">): Promise<T> {
        const start = performance.now();
        const { body: requestBody, headers: requestHeaders, method = "GET", ...dispatcherOptions } = reqOpts;
        let body = requestBody;
        const headers = { ...this.defaultHeaders, ...requestHeaders } as Record<string, string>;

        if (body && typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
            body = JSON.stringify(body);
            if (!this.hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
        }

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

        // Download
        const rawBody = await response.body.text();

        // Measure Total (Fallback)
        if (!this.useTTFB) measuredDuration = performance.now() - start;

        const statusCode = response.statusCode;
        const resHeaders = this.sanitizeHeaders(response.headers);

        // Adaptive Logic Hook
        if (this.adaptiveEnabled && measuredDuration > 0 && statusCode < 400) {
            this.updateThrottleLogic(measuredDuration);
        }

        this.assertSuccess(statusCode, rawBody, resHeaders);
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

    private parseBody<T>(statusCode: number, rawBody: string, resHeaders: Record<string, string | string[] | undefined>): T {
        const contentType = this.getHeaderValue(resHeaders["content-type"]);
        if (contentType && contentType.includes("application/json")) {
            try {
                return JSON.parse(rawBody) as T;
            } catch {
                throw new CallPoolError("Invalid JSON response", { statusCode, body: rawBody, headers: resHeaders, retryable: false });
            }
        }

        return rawBody as unknown as T;
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
        this.limiter.updateSettings({ maxConcurrent: this.currentConcurrency });
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
        await this.limiter.stop();
        await this.client.close();
    }
}
