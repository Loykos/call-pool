import { setTimeout as sleep } from "node:timers/promises";
import { Pool, errors } from "undici";
import { CallPoolOptions, CallPoolStats, CallPoolTlsOptions, RequestOptions } from "./types.js";
import { CallPoolError, PoolClosedError } from "./errors.js";
import { RateGate } from "./rate-gate.js";
import { RequestScheduler } from "./scheduler.js";
import { validateOptions } from "./validation.js";

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
        validateOptions(options);

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

        // Adaptive Bounds Setup (validation guarantees 1 <= minConcurrency <= limit)
        this.minConcurrency = adaptOpts?.minConcurrency ?? 1;
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
        this.client = this.createClient(options.baseUrl, concurrencyLimit, options.network?.tls);
        this.scheduler = new RequestScheduler({ maxConcurrent: this.currentConcurrency });
        const minTime = this.computeBaseMinTime(rateOpts);
        this.rateGate = minTime > 0 || rateOpts?.quota ? new RateGate({ minTime, quota: rateOpts?.quota }) : null;
    }

    private computeBaseMinTime(rateOpts: CallPoolOptions["rateLimit"]): number {
        if (rateOpts?.minTime !== "auto") return rateOpts?.minTime ?? 0;
        if (!rateOpts.quota) throw new Error("[CallPool] 'auto' requires 'quota'");
        return Math.ceil(rateOpts.quota.window / rateOpts.quota.max);
    }

    private createClient(baseUrl: string, connections: number, tls?: CallPoolTlsOptions): Pool {
        // Undici Pool needs the HARD limit (total sockets available)
        return new Pool(baseUrl, {
            connections,
            pipelining: 1,
            keepAliveTimeout: 10_000,
            // Spread instead of `connect: undefined`: undici skips its default
            // connector when the key is present, so pools without TLS options
            // must not carry the key at all.
            ...(tls ? { connect: { ...tls } } : {}),
        });
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
                // Abort resolves the wait instead of throwing: the loop's next
                // iteration rethrows signal.reason, preserving the abort cause.
                await sleep(waitMs, undefined, { signal }).catch(() => {});
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

        const ttfb = performance.now() - start;
        const statusCode = response.statusCode;
        const resHeaders = this.sanitizeHeaders(response.headers);
        const contentType = this.getHeaderValue(resHeaders["content-type"]);
        const isBinaryResponse = statusCode < 400 && contentType !== undefined && !contentType.includes("application/json") && !this.isTextContentType(contentType);

        // Preserve bytes only for successful binary media. Text, JSON and error
        // bodies keep their established string representation.
        const rawBody = isBinaryResponse ? Buffer.from(await response.body.arrayBuffer()) : await response.body.text();

        const measuredDuration = this.useTTFB ? ttfb : performance.now() - start;

        // Adaptive Logic Hook
        if (this.adaptiveEnabled && measuredDuration > 0 && statusCode < 400) {
            this.updateThrottleLogic(measuredDuration);
        }

        // A Buffer rawBody implies isBinaryResponse, hence statusCode < 400:
        // assertSuccess never reads the body there, so skip the utf8 decode.
        this.assertSuccess(statusCode, typeof rawBody === "string" ? rawBody : "", resHeaders);
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
