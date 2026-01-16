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
        limit?: number; // Default: 10
    };

    /** Static Configuration (Contractual Rate Limit) */
    rateLimit?: {
        /** Minimum time between requests. If "auto", requires `quota`. */
        minTime?: number | "auto";
        /** Defined quota (e.g. 100 req / 60000ms) */
        quota?: { max: number; window: number };
    };

    /** * Dynamic Configuration (Adaptive Throttling / Network Awareness).
     * Manages speed based on actual server latency.
     */
    adaptive?: {
        /** * Enables dynamic throttling.
         * Default: false
         */
        enabled?: boolean;

        /**
         * true: Measures only TTFB (Time To First Byte). Great for variable payloads.
         * false: Measures complete download.
         * Default: true
         */
        useTTFB?: boolean;

        /**
         * Minimum duration threshold (ms). If request lasts less than X, it's ignored.
         * Default: 100ms
         */
        ignoreBelow?: number;

        /**
         * Average multiplier to define congestion.
         * E.g. 2.0 = If latency > 2x average, we consider it congestion.
         * Default: 2.0
         */
        congestionRatio?: number;

        /**
         * How many consecutive times congestion must be detected before slowing down.
         * Filters outliers (e.g. GC spikes or isolated packet loss).
         * Default: 2
         */
        breachLimit?: number;

        /** [AIMD] Additive Increase: How many ms to add to delay in congestion. Default: 50 */
        increaseStep?: number;

        /** [AIMD] Multiplicative Decrease: Reduction factor (0-1) in recovery. Default: 0.9 */
        decreaseFactor?: number;

        /** Maximum ceiling for calculated minTime (ms). Default: 5000 */
        maxMinTime?: number;

        /** Minimum ms between two configuration updates (Debounce). Default: 250 */
        tuningDebounce?: number;

        /** Minimum % variation needed to apply a settings change. Default: 0.05 (5%) */
        tuningPercent?: number;
    };

    /** Retry Configuration (Resilience) */
    retry?: {
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

export interface RequestOptions extends Omit<Dispatcher.RequestOptions, "origin" | "path" | "method" | "body"> {
    method?: Dispatcher.HttpMethod;
    priority?: number;
    body?: string | Buffer | Uint8Array | Record<string, any> | null;
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
    private maxMinTime: number;

    // Tuning Config
    private tuningDebounce: number;
    private tuningPercent: number;

    // Adaptive State
    private lastSettingsUpdate: number = -Infinity;
    private pendingUpdateTimer: NodeJS.Timeout | null = null;
    private pendingMinTime: number | null = null;
    private avgLatency: number = 0;
    private congestionHits: number = 0;

    // Limiter State
    private baseMinTime: number;
    private currentMinTime: number;

    constructor(options: CallPoolOptions) {
        const concurrencyLimit = options.concurrency?.limit ?? 10;
        const rateOpts = options.rateLimit;
        const adaptOpts = options.adaptive;

        // --- 1. ADAPTIVE CONFIGURATION ---
        this.adaptiveEnabled = adaptOpts?.enabled ?? false;
        this.useTTFB = adaptOpts?.useTTFB ?? true;
        this.adaptiveIgnoreBelow = adaptOpts?.ignoreBelow ?? 100;
        this.congestionRatio = adaptOpts?.congestionRatio ?? 2.0;
        this.breachLimit = adaptOpts?.breachLimit ?? 2;
        this.increaseStep = adaptOpts?.increaseStep ?? 50;
        this.decreaseFactor = adaptOpts?.decreaseFactor ?? 0.9;
        this.maxMinTime = adaptOpts?.maxMinTime ?? 5000;

        this.tuningDebounce = adaptOpts?.tuningDebounce ?? 250;
        this.tuningPercent = adaptOpts?.tuningPercent ?? 0.05;

        // --- 2. NETWORK & RETRY CONFIGURATION ---
        this.requestTimeout = options.network?.timeout ?? 30_000;
        this.defaultHeaders = options.network?.defaultHeaders ?? {};

        this.retryOptions = {
            retries: options.retry?.maxAttempts ?? 3,
            minTimeout: options.retry?.delay ?? 1000,
            factor: options.retry?.factor ?? 2,
        };

        // --- 3. BASE MINTIME CALCULATION ---
        if (rateOpts?.minTime === "auto") {
            if (!rateOpts.quota) throw new Error("[CallPool] 'auto' requires 'quota'");
            this.baseMinTime = Math.ceil(rateOpts.quota.window / rateOpts.quota.max);
        } else {
            this.baseMinTime = rateOpts?.minTime ?? 0;
        }
        this.currentMinTime = this.baseMinTime;

        // --- 4. SETUP UNDICI & BOTTLENECK ---
        this.client = new Pool(options.baseUrl, {
            connections: concurrencyLimit,
            pipelining: 1,
            keepAliveTimeout: 10_000,
        });

        this.limiter = new Bottleneck({
            maxConcurrent: concurrencyLimit,
            minTime: this.baseMinTime,
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

    public async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
        const { priority = 5, ...reqOpts } = options;
        return this.limiter.schedule({ priority }, () => this.executeWithRetry<T>(path, reqOpts));
    }

    private async executeWithRetry<T>(path: string, reqOpts: Omit<RequestOptions, "priority">): Promise<T> {
        return pRetry(async () => {
            const start = performance.now();
            let response: Dispatcher.ResponseData;
            let rawBody: string;
            let measuredDuration = 0;

            try {
                let body = reqOpts.body;
                const headers = { ...this.defaultHeaders, ...reqOpts.headers } as Record<string, string>;

                if (body && typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
                    body = JSON.stringify(body);
                    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
                }

                // Request
                response = await this.client.request({
                    path,
                    method: reqOpts.method || "GET",
                    headers,
                    body: body as string | Buffer | Uint8Array | null,
                    headersTimeout: this.requestTimeout,
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
                const retryAfterSec = Number(response.headers["retry-after"]) || 5;
                await this.forceWait(retryAfterSec * 1000);
                throw new Error(`Rate Limit Hit (429) - Waited ${retryAfterSec}s`);
            }

            // Adaptive Logic Hook
            // FILTER: We only measure Success (2xx/3xx).
            // We ignore 4xx (often fast failures) and 5xx (server faults, handled by retry).
            if (this.adaptiveEnabled && measuredDuration > 0 && statusCode < 400) {
                this.updateThrottleLogic(measuredDuration);
            }

            // HTTP Errors
            if (statusCode >= 500) throw new Error(`Server Error ${statusCode}`);
            if (statusCode >= 400) throw new AbortError(`Client Error ${statusCode}: ${rawBody.substring(0, 200)}`);

            // Parsing
            const contentType = response.headers["content-type"];
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

    // ==========================================
    // ADAPTIVE LOGIC CORE (AIMD + Noise Filter)
    // ==========================================

    private updateThrottleLogic(duration: number) {
        if (this.avgLatency === 0) {
            this.avgLatency = duration;
            return;
        }

        // EMA Update
        this.avgLatency = 0.2 * duration + 0.8 * this.avgLatency;

        // A. Low Latency Guard
        if (duration < this.adaptiveIgnoreBelow) {
            this.congestionHits = 0;
            if (this.currentMinTime > this.baseMinTime) this.decreaseDelay();
            return;
        }

        // B. Congestion Check
        if (duration > this.avgLatency * this.congestionRatio) {
            this.congestionHits++;
            if (this.congestionHits >= this.breachLimit) {
                this.congestionHits = 0; // RESET
                this.increaseDelay();
            }
        } else {
            // C. Recovery
            this.congestionHits = 0;
            if (this.currentMinTime > this.baseMinTime) {
                this.decreaseDelay();
            }
        }
    }

    private increaseDelay() {
        const nextDelay = Math.min(this.currentMinTime + this.increaseStep, this.maxMinTime);
        this.applyNewSettings(nextDelay);
    }

    private decreaseDelay() {
        const nextDelay = Math.max(this.currentMinTime * this.decreaseFactor, this.baseMinTime);
        this.applyNewSettings(nextDelay);
    }

    private applyNewSettings(newMinTime: number) {
        newMinTime = Math.ceil(newMinTime);

        // 1. THRESHOLD Check
        const diff = Math.abs(newMinTime - this.currentMinTime);
        const percentThreshold = this.currentMinTime > 0 ? this.currentMinTime * this.tuningPercent : 10;

        if (diff < Math.max(10, percentThreshold)) return;

        // 2. DEBOUNCE & TRAILING Logic
        const now = performance.now();
        const timeSinceLastUpdate = now - this.lastSettingsUpdate;

        if (timeSinceLastUpdate >= this.tuningDebounce) {
            // Immediate update
            this.performUpdate(newMinTime);
        } else {
            // Delayed update (Trailing)
            this.pendingMinTime = newMinTime;

            if (!this.pendingUpdateTimer) {
                const waitMs = this.tuningDebounce - timeSinceLastUpdate;

                this.pendingUpdateTimer = setTimeout(() => {
                    this.pendingUpdateTimer = null;

                    const value = this.pendingMinTime;
                    this.pendingMinTime = null;

                    if (value !== null) {
                        this.performUpdate(value);
                    }
                }, waitMs);
            }
        }
    }

    private performUpdate(value: number) {
        if (this.pendingUpdateTimer) {
            clearTimeout(this.pendingUpdateTimer);
            this.pendingUpdateTimer = null;
        }
        this.pendingMinTime = null;

        this.currentMinTime = value;
        this.lastSettingsUpdate = performance.now();
        this.limiter.updateSettings({ minTime: this.currentMinTime });
    }

    private async forceWait(ms: number) {
        await new Promise(r => setTimeout(r, ms));
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
