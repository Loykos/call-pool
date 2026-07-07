import { Pool, Dispatcher } from "undici";
import Bottleneck from "bottleneck";
import pRetry, { AbortError, Options as PRetryOptions } from "p-retry";
import { performance } from "perf_hooks";

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
    };

    /** Retry Configuration (Resilience) */
    retry?: {
        /** Total number of attempts, including the initial request. Default: 3 */
        maxAttempts?: number;
        delay?: number;
        factor?: number;
    };

    /** Undici Network Options */
    network?: {
        timeout?: number;
        defaultHeaders?: Record<string, string>;
    };
}

export interface RequestOptions extends Omit<Dispatcher.RequestOptions, "origin" | "path" | "method" | "body" | "headers"> {
    method?: Dispatcher.HttpMethod;
    priority?: number;
    body?: string | Buffer | Uint8Array | Record<string, any> | null;
    headers?: Record<string, string>;
}

// ==========================================
// MAIN CLASS
// ==========================================

export class CallPool {
    private client: Pool;
    private limiter: Bottleneck;

    // Runtime Config
    private retryOptions: PRetryOptions;
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
    private tuningDebounce: number;
    private readonly emaAlpha = 0.2;

    // Adaptive State
    private lastSettingsUpdate: number = -Infinity;
    private pendingUpdateTimer: NodeJS.Timeout | null = null;
    private avgLatency: number = 0;
    private congestionHits: number = 0;

    // Limiter State
    private currentConcurrency: number;

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

        // Adaptive Bounds Setup (Sanitized)
        this.minConcurrency = Math.max(1, Math.floor(adaptOpts?.minConcurrency ?? 1));
        this.maxConcurrency = Math.max(concurrencyLimit, this.minConcurrency);

        this.tuningDebounce = 250;

        // --- 2. NETWORK & RETRY CONFIGURATION ---
        this.requestTimeout = options.network?.timeout ?? 30_000;
        this.defaultHeaders = options.network?.defaultHeaders ?? {};

        const maxAttempts = options.retry?.maxAttempts ?? 3;
        this.retryOptions = {
            retries: maxAttempts - 1,
            minTimeout: options.retry?.delay ?? 1000,
            factor: options.retry?.factor ?? 2,
        };

        // --- 3. BASE MINTIME CALCULATION ---
        let baseMinTime = 0;
        if (rateOpts?.minTime === "auto") {
            if (!rateOpts.quota) throw new Error("[CallPool] 'auto' requires 'quota'");
            baseMinTime = Math.ceil(rateOpts.quota.window / rateOpts.quota.max);
        } else {
            baseMinTime = rateOpts?.minTime ?? 0;
        }

        // --- 3.1 CONCURRENCY SETUP ---
        // Start at the maximum allowed by adaptive logic
        this.currentConcurrency = this.maxConcurrency;

        // --- 4. SETUP UNDICI & BOTTLENECK ---
        // Undici Pool needs the HARD limit (total sockets available)
        this.client = new Pool(options.baseUrl, {
            connections: concurrencyLimit,
            pipelining: 1,
            keepAliveTimeout: 10_000,
        });

        // Bottleneck starts with the current adaptive concurrency
        this.limiter = new Bottleneck({
            maxConcurrent: this.currentConcurrency,
            minTime: baseMinTime,
            reservoir: rateOpts?.quota?.max ?? null,
            reservoirRefreshAmount: rateOpts?.quota?.max ?? null,
            reservoirRefreshInterval: rateOpts?.quota?.window ?? null,
            strategy: Bottleneck.strategy.BLOCK,
            highWater: 10_000,
        });

        this.setupMonitoring();
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

        const quota = options.rateLimit?.quota;
        if (quota) {
            if (!Number.isInteger(quota.max) || quota.max < 1) {
                throw new Error("[CallPool] 'rateLimit.quota.max' must be a positive integer");
            }
            if (!Number.isFinite(quota.window) || quota.window <= 0) {
                throw new Error("[CallPool] 'rateLimit.quota.window' must be a positive number");
            }
        }

        const minTime = options.rateLimit?.minTime;
        if (minTime === "auto" && !quota) {
            throw new Error("[CallPool] 'auto' requires 'quota'");
        }
        if (minTime !== undefined && minTime !== "auto" && (!Number.isFinite(minTime) || minTime < 0)) {
            throw new Error("[CallPool] 'rateLimit.minTime' must be a non-negative number or 'auto'");
        }

        const retry = options.retry;
        if (retry?.maxAttempts !== undefined && (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)) {
            throw new Error("[CallPool] 'retry.maxAttempts' must be a positive integer");
        }
        if (retry?.delay !== undefined && (!Number.isFinite(retry.delay) || retry.delay < 0)) {
            throw new Error("[CallPool] 'retry.delay' must be a non-negative number");
        }
        if (retry?.factor !== undefined && (!Number.isFinite(retry.factor) || retry.factor < 1)) {
            throw new Error("[CallPool] 'retry.factor' must be greater than or equal to 1");
        }

        const timeout = options.network?.timeout;
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
            throw new Error("[CallPool] 'network.timeout' must be a positive number");
        }

        const adaptive = options.adaptive;
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
    }

    public async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
        const { priority = 5, ...reqOpts } = options;
        if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
            throw new Error("[CallPool] 'priority' must be an integer between 0 and 9");
        }
        return this.limiter.schedule({ priority }, () => this.executeWithRetry<T>(path, reqOpts));
    }

    private async executeWithRetry<T>(path: string, reqOpts: Omit<RequestOptions, "priority">): Promise<T> {
        return pRetry(async () => {
            const start = performance.now();
            let response: Dispatcher.ResponseData;
            let rawBody: string;
            let measuredDuration = 0;

            try {
                const { body: requestBody, headers: requestHeaders, method = "GET", ...dispatcherOptions } = reqOpts;
                let body = requestBody;
                const headers = { ...this.defaultHeaders, ...requestHeaders } as Record<string, string>;

                if (body && typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
                    body = JSON.stringify(body);
                    if (!this.hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
                }

                // Request
                response = await this.client.request({
                    ...dispatcherOptions,
                    path,
                    method,
                    headers,
                    body: body as string | Buffer | Uint8Array | null,
                    headersTimeout: dispatcherOptions.headersTimeout ?? this.requestTimeout,
                    bodyTimeout: dispatcherOptions.bodyTimeout ?? this.requestTimeout,
                });

                // Measure TTFB
                if (this.useTTFB) measuredDuration = performance.now() - start;

                // Download
                rawBody = await response.body.text();

                // Measure Total (Fallback)
                if (!this.useTTFB) measuredDuration = performance.now() - start;
            } catch (err) {
                // Network Error -> Retry
                throw err;
            }

            const statusCode = response.statusCode;

            // Handle 429 (Rate Limit)
            if (statusCode === 429) {
                const retryAfterMs = this.parseRetryAfterMs(response.headers["retry-after"]);
                await this.forceWait(retryAfterMs);
                throw new Error(`Rate Limit Hit (429) - Waited ${Math.ceil(retryAfterMs / 1000)}s`);
            }

            // Adaptive Logic Hook
            if (this.adaptiveEnabled && measuredDuration > 0 && statusCode < 400) {
                this.updateThrottleLogic(measuredDuration);
            }

            // HTTP Errors
            if (statusCode >= 500) throw new Error(`Server Error ${statusCode}`);
            if (statusCode >= 400) throw new AbortError(`Client Error ${statusCode}: ${rawBody.substring(0, 200)}`);

            // Parsing
            const contentType = this.getHeaderValue(response.headers["content-type"]);
            if (contentType && contentType.includes("application/json")) {
                try {
                    return JSON.parse(rawBody) as T;
                } catch (e) {
                    throw new AbortError("Invalid JSON response");
                }
            }

            return rawBody as unknown as T;
        }, this.retryOptions);
    }

    private hasHeader(headers: Record<string, string>, name: string) {
        const lowerName = name.toLowerCase();
        return Object.keys(headers).some(key => key.toLowerCase() === lowerName);
    }

    private getHeaderValue(value: string | string[] | undefined) {
        return Array.isArray(value) ? value[0] : value;
    }

    private parseRetryAfterMs(value: string | string[] | undefined) {
        const retryAfter = this.getHeaderValue(value);
        if (!retryAfter) return 5000;

        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());

        return 5000;
    }

    // ==========================================
    // ADAPTIVE LOGIC CORE (Single-threshold + stable baseline)
    // ==========================================

    private updateThrottleLogic(duration: number) {
        // First sample establishes the baseline
        if (this.avgLatency === 0) {
            this.avgLatency = duration;
            return;
        }

        // Trivially fast request: the server has headroom -> recover.
        // Excluded from the baseline so cache hits can't corrupt it.
        if (duration < this.adaptiveIgnoreBelow) {
            this.congestionHits = 0;
            this.increaseConcurrency();
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

    private async forceWait(ms: number) {
        await new Promise(r => setTimeout(r, ms));
    }

    public getCurrentConcurrency() {
        return this.currentConcurrency;
    }

    public async close() {
        if (this.pendingUpdateTimer) {
            clearTimeout(this.pendingUpdateTimer);
            this.pendingUpdateTimer = null;
        }
        await this.limiter.stop();
        await this.client.close();
    }
}
