import { setTimeout as sleep } from "node:timers/promises";
import { Pool, ProxyAgent, errors } from "undici";
import { CallPoolOptions, CallPoolResponse, CallPoolStats, CallPoolTlsOptions, RateLimitSignalOptions, RequestOptions } from "./types.js";
import { CallPoolError, PoolClosedError } from "./errors.js";
import { RateGate } from "./rate-gate.js";
import { RequestScheduler } from "./scheduler.js";
import { validateOptions } from "./validation.js";

/** Per-request options left after the pool-level keys are extracted. */
type TransportOptions = Omit<RequestOptions, "priority" | "response" | "exposeCookies">;

const RATE_LIMIT_SIGNAL_DEFAULTS: Required<RateLimitSignalOptions> = { decreaseFactor: 0.5, pause: true, recoveryAfter: 10 };

export class CallPool {
    private client: Pool | ProxyAgent;
    /** Set only when proxied: ProxyAgent needs the target origin on every request. */
    private proxiedOrigin: string | null = null;
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

    // Rate-limit signal (adaptive only): null when 429s stay per-request
    private rateLimitSignal: Required<RateLimitSignalOptions> | null;

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
    /** End of the current rate-limit episode (performance.now() timebase) */
    private rateLimitedUntil: number = -Infinity;
    /** Successes still required after the last 429 before concurrency may grow */
    private rateLimitHold: number = 0;
    /** Pause of the last rate-limit episode, doubled when the server refuses again before recovery */
    private rateLimitBackoff: number = 0;

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
        this.rateLimitSignal = this.resolveRateLimitSignal(adaptOpts);

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
        this.client = this.createClient(options.baseUrl, concurrencyLimit, options.network?.tls, options.network?.proxy);
        this.scheduler = new RequestScheduler({ maxConcurrent: this.currentConcurrency });
        const minTime = this.computeBaseMinTime(rateOpts);
        // The pause of a rate-limit episode is enforced by the gate, so it is
        // created even for a pool without contractual limits.
        const needsGate = minTime > 0 || rateOpts?.quota || this.rateLimitSignal?.pause;
        this.rateGate = needsGate ? new RateGate({ minTime, quota: rateOpts?.quota }) : null;
    }

    private resolveRateLimitSignal(adaptOpts: CallPoolOptions["adaptive"]): Required<RateLimitSignalOptions> | null {
        const signal = adaptOpts?.rateLimitSignal;
        if (!this.adaptiveEnabled || !signal) return null;
        return { ...RATE_LIMIT_SIGNAL_DEFAULTS, ...(signal === true ? {} : signal) };
    }

    private computeBaseMinTime(rateOpts: CallPoolOptions["rateLimit"]): number {
        if (rateOpts?.minTime !== "auto") return rateOpts?.minTime ?? 0;
        if (!rateOpts.quota) throw new Error("[CallPool] 'auto' requires 'quota'");
        return Math.ceil(rateOpts.quota.window / rateOpts.quota.max);
    }

    private createClient(baseUrl: string, connections: number, tls?: CallPoolTlsOptions, proxy?: string): Pool | ProxyAgent {
        if (proxy) {
            this.proxiedOrigin = new URL(baseUrl).origin;
            const proxyUrl = new URL(proxy);
            // Credentials travel as Proxy-Authorization, not embedded in the
            // uri: undici only reads them reliably from `token`.
            const token = proxyUrl.username
                ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}`
                : undefined;
            return new ProxyAgent({
                uri: proxyUrl.origin,
                ...(token ? { token } : {}),
                connections,
                pipelining: 1,
                keepAliveTimeout: 10_000,
                // TLS options apply to the tunneled connection to the target,
                // not to the hop toward the proxy.
                ...(tls ? { requestTls: { ...tls } } : {}),
            });
        }

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
     * `Content-Type` is `application/json` or has a `+json` suffix (case-insensitive),
     * as a string for textual content, or as a byte-preserving Buffer for binary
     * content. Empty HEAD/204/205/304 responses resolve with undefined unless
     * `binary: true` requests an empty Buffer.
     * HTTP failures (4xx/5xx) reject with {@link CallPoolError}; retryable failures
     * (429, 408, 5xx) are retried up to `retry.maxAttempts`, honoring a capped
     * `Retry-After` wait on 429s. Network-level errors (DNS, connection reset,
     * timeouts) propagate unchanged.
     *
     * @param path - Request path, appended to `baseUrl`.
     * @param options - Per-request overrides. `signal` aborts the request, including
     * queue, quota/minTime and retry waits. `priority` (0-9, default 5) sets scheduling order in
     * the limiter's queue; lower values run first. `response: "raw"` resolves with a
     * `{ status, headers, body }` envelope instead of the bare body, with the same
     * error/retry semantics; `exposeCookies` additionally reveals Set-Cookie there.
     * `binary: true` reads the body as bytes whatever `Content-Type` says, for
     * servers that omit or misreport it.
     * @throws {CallPoolError} On a non-retryable HTTP failure, or after retries are exhausted.
     * @throws {Error} If `priority` is not an integer between 0 and 9.
     */
    public async request<T = unknown>(path: string, options?: RequestOptions & { response?: "body" }): Promise<T>;
    public async request<T = unknown>(path: string, options: RequestOptions & { response: "raw" }): Promise<CallPoolResponse<T>>;
    public async request<T = unknown>(path: string, options?: RequestOptions): Promise<T | CallPoolResponse<T>>;
    public async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T | CallPoolResponse<T>> {
        const { priority = 5, response = "body", exposeCookies = false, ...reqOpts } = options;
        if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
            throw new Error("[CallPool] 'priority' must be an integer between 0 and 9");
        }
        const signal = reqOpts.signal instanceof AbortSignal ? reqOpts.signal : undefined;
        const envelope = await this.scheduler.schedule(priority, () => this.executeWithRetry<T>(path, reqOpts, exposeCookies), signal);
        return response === "raw" ? envelope : envelope.body;
    }

    private async executeWithRetry<T>(path: string, reqOpts: TransportOptions, exposeCookies: boolean): Promise<CallPoolResponse<T>> {
        const signal = reqOpts.signal instanceof AbortSignal ? reqOpts.signal : undefined;
        let delay = this.retryDelay;

        // Retry waits happen INSIDE the scheduler slot: a retrying logical job
        // keeps occupying its concurrency slot, which acts as natural backpressure.
        for (let attempt = 1; ; attempt++) {
            signal?.throwIfAborted();

            try {
                const response = await this.executeOnce<T>(path, reqOpts, exposeCookies);
                signal?.throwIfAborted();
                return response;
            } catch (err) {
                // Undici and timers can wrap abort errors. Preserve the caller's
                // reason consistently, including non-Error values and null.
                signal?.throwIfAborted();
                // The signal is the server's, whatever this request does next:
                // a 429 on the last attempt still says the pool is too fast.
                if (err instanceof CallPoolError && err.statusCode === 429) {
                    this.onRateLimited(err.retryAfterMs ?? delay, Boolean(this.getHeaderValue(err.headers?.["retry-after"])));
                }
                const retryable = this.isRetryableError(err);
                if (!retryable || attempt >= this.maxAttempts) throw err;

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

    private async executeOnce<T>(path: string, reqOpts: TransportOptions, exposeCookies: boolean): Promise<CallPoolResponse<T>> {
        const { body: requestBody, headers: requestHeaders, method = "GET", binary = false, ...dispatcherOptions } = reqOpts;
        // The type-level Omit doesn't stop plain-JS callers: drop the key for real.
        delete (dispatcherOptions as { throwOnError?: boolean }).throwOnError;
        let body = requestBody;
        const headers = this.mergeHeaders(requestHeaders);

        if (body && typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
            body = JSON.stringify(body);
            if (!("content-type" in headers)) headers["content-type"] = "application/json";
        }

        const signal = reqOpts.signal instanceof AbortSignal ? reqOpts.signal : undefined;
        signal?.throwIfAborted();
        if (this.rateGate) await this.rateGate.acquire(signal);
        // Abort can arrive after the gate grants permission but before this
        // async continuation resumes. Do not dispatch HTTP in that case.
        signal?.throwIfAborted();
        const start = performance.now();
        const response = await this.client.request({
            ...dispatcherOptions,
            // A Pool is bound to its origin; a ProxyAgent is origin-agnostic
            // and must be told the tunnel target on every request.
            ...(this.proxiedOrigin ? { origin: this.proxiedOrigin } : {}),
            path,
            method,
            headers,
            body: body as string | Buffer | Uint8Array | null,
            headersTimeout: dispatcherOptions.headersTimeout ?? this.requestTimeout,
            bodyTimeout: dispatcherOptions.bodyTimeout ?? this.requestTimeout,
        });

        const ttfb = performance.now() - start;
        const statusCode = response.statusCode;
        const adaptThisResponse = this.adaptiveEnabled && statusCode < 400;
        if (statusCode < 400 && this.rateLimitHold > 0) this.rateLimitHold--;
        // TTFB feedback can change scheduling while this body is still downloading.
        if (adaptThisResponse && this.useTTFB && ttfb > 0) {
            this.updateThrottleLogic(ttfb);
        }
        const resHeaders = this.sanitizeHeaders(response.headers);
        const responseType = this.getResponseBodyType(this.getHeaderValue(resHeaders["content-type"]));
        // `binary` is the caller's own answer to the question the header is
        // meant to answer: a server that omits Content-Type, or calls a JPEG
        // text, would otherwise cost the response its bytes in a UTF-8 decode.
        const isBinaryResponse = statusCode < 400 && (binary || responseType === "binary");

        // Preserve bytes only for successful binary media. Text, JSON and error
        // bodies keep their established string representation.
        const rawBody = isBinaryResponse ? Buffer.from(await response.body.arrayBuffer()) : await response.body.text();

        // Full-download mode samples here; TTFB mode already sampled at headers.
        if (adaptThisResponse && !this.useTTFB) {
            const measuredDuration = performance.now() - start;
            if (measuredDuration > 0) this.updateThrottleLogic(measuredDuration);
        }

        // A Buffer rawBody implies isBinaryResponse, hence statusCode < 400:
        // assertSuccess never reads the body there, so skip the utf8 decode.
        this.assertSuccess(statusCode, typeof rawBody === "string" ? rawBody : "", resHeaders);

        // Only bodyless HTTP responses skip decoding. An empty ordinary JSON
        // response is still invalid, and an explicit byte request stays a Buffer.
        const emptyResponse = rawBody.length === 0 && (method === "HEAD" || statusCode === 204 || statusCode === 205 || statusCode === 304);

        // Errors above always carry the sanitized copy; the opt-in only
        // uncovers Set-Cookie in the success envelope the caller asked for.
        return {
            status: statusCode,
            headers: exposeCookies ? { ...response.headers } : resHeaders,
            body: emptyResponse && !binary ? undefined as T : this.parseBody<T>(statusCode, rawBody, resHeaders, responseType === "json"),
        };
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

    private parseBody<T>(statusCode: number, rawBody: string | Buffer, resHeaders: Record<string, string | string[] | undefined>, isJson: boolean): T {
        // Bytes were asked for, explicitly or by content type: parsing them
        // back into JSON would undo the very thing that was requested.
        if (Buffer.isBuffer(rawBody)) return rawBody as unknown as T;
        if (isJson) {
            try {
                return JSON.parse(rawBody) as T;
            } catch {
                throw new CallPoolError("Invalid JSON response", { statusCode, body: rawBody, headers: resHeaders, retryable: false });
            }
        }

        return rawBody as unknown as T;
    }

    private getResponseBodyType(contentType: string | undefined): "json" | "text" | "binary" {
        if (contentType === undefined) return "text";
        // Share one classification between byte reading and JSON decoding;
        // media type parameters must not influence either decision.
        const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
        if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
        if (
            mediaType.startsWith("text/") ||
            mediaType.endsWith("+xml") ||
            mediaType === "application/xml" ||
            mediaType === "application/javascript" ||
            mediaType === "application/x-javascript" ||
            mediaType === "application/x-www-form-urlencoded" ||
            mediaType === "image/svg+xml"
        ) return "text";
        return "binary";
    }

    private mergeHeaders(requestHeaders?: Record<string, string>): Record<string, string> {
        const headers: Record<string, string> = Object.create(null);
        // Normalize each source separately so request overrides always win,
        // even when defaults contain multiple spellings of the same name.
        for (const [name, value] of Object.entries(this.defaultHeaders)) headers[name.toLowerCase()] = value;
        if (requestHeaders) {
            for (const [name, value] of Object.entries(requestHeaders)) headers[name.toLowerCase()] = value;
        }
        return headers;
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
        // After a 429 the latency baseline says nothing about the server's
        // quota: growth waits for `recoveryAfter` successes.
        if (this.rateLimitHold > 0) return;
        const next = Math.min(this.currentConcurrency + this.increaseStep, this.maxConcurrency);
        this.applyNewSettings(next);
    }

    private reduceConcurrency(factor: number = this.decreaseFactor) {
        // AIMD decrease: multiplicative factor, but always at least -1 connection.
        const raw = Math.min(this.currentConcurrency * factor, this.currentConcurrency - 1);
        const next = Math.max(raw, this.minConcurrency);
        this.applyNewSettings(next);
    }

    /**
     * A 429 under `adaptive.rateLimitSignal`: one decrease per episode, the
     * episode extended by every later 429, growth held for `recoveryAfter`
     * successes and, with `pause`, every new attempt held until the wait the
     * server asked for is over. A server that names no wait and refuses again
     * before the pool has recovered gets twice the previous pause, up to
     * `retry.maxRetryAfter`: the default wait was evidently too short.
     */
    private onRateLimited(waitMs: number, explicit: boolean) {
        const signal = this.rateLimitSignal;
        if (!signal) return;

        const now = performance.now();
        const newEpisode = now >= this.rateLimitedUntil;
        if (newEpisode) this.rateLimitBackoff = this.episodeWait(waitMs, explicit);
        const wait = explicit ? waitMs : Math.max(waitMs, this.rateLimitBackoff);
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, now + wait);
        this.rateLimitHold = signal.recoveryAfter;
        this.congestionHits = 0;

        if (newEpisode) {
            this.reduceConcurrency(signal.decreaseFactor);
            // The server is refusing now: apply the cut without the debounce.
            this.flushLimiterUpdate();
        }
        if (signal.pause) this.rateGate?.pauseUntil(this.rateLimitedUntil);
    }

    private episodeWait(waitMs: number, explicit: boolean): number {
        const escalate = !explicit && this.rateLimitHold > 0;
        return escalate ? Math.min(Math.max(waitMs, this.rateLimitBackoff * 2), this.maxRetryAfter) : waitMs;
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
            pausedFor: this.rateGate?.pausedFor() ?? 0,
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
