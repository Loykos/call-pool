import type { Dispatcher, Pool, ProxyAgent } from "undici";

/** HTTP failures eligible for a retry or a shared pause. */
export type StatusCodeSelector = number | "4xx" | "5xx";

/** Native constructor options. `uri` selects Undici ProxyAgent instead of Pool. */
export type NetworkOptions = (Pool.Options & { uri?: never }) | ProxyAgent.Options;

export interface CallPoolOptions {
    /** Base URL for all requests (e.g. "https://api.example.com") */
    baseUrl: string;

    /** Maximum concurrent logical requests (independent of network.connections). */
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
         * true: Measures TTFB (Time To First Byte) and updates the controller as
         * soon as non-error response headers arrive, before reading the body.
         * That sample is retained even if the later body download fails.
         * false: Updates the controller after the complete body download.
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

        /**
         * Reduces concurrency on 429 and holds recovery for successful responses.
         * Requires adaptive.enabled. Does not pause the pool: use retry.pauseCodes.
         * Default: false; true uses RateLimitSignalOptions defaults.
         */
        rateLimitSignal?: boolean | RateLimitSignalOptions;
    };

    /** Default total budget in ms, from submission including queue and retries.
     * Positive and finite; omitted means unlimited. Overridable per request.
     */
    maxElapsedTime?: number;

    /** Default target request headers; per-request headers override these. */
    defaultHeaders?: Record<string, string>;

    /** Reactive failure policy, independent of adaptive throttling. */
    retry?: {
        /** Total HTTP attempts including the first. Default: 3 */
        maxAttempts?: number;
        /** Replaces the default [408, 429, "5xx"]. [] disables HTTP retries. */
        codes?: readonly StatusCodeSelector[];
        /** Independent of codes. Holds all new attempts, even after a final failure. Default: [] */
        pauseCodes?: readonly StatusCodeSelector[];
        /** Retry transport failures (never cancellation or invalid arguments). Default: true */
        networkErrors?: boolean;
        /** Initial fallback wait in ms when Retry-After is absent/invalid. Default: 1000 */
        delay?: number;
        /** Fallback multiplier per retry / shared pause episode. Default: 2 */
        factor?: number;
        /** Maximum fallback wait in ms, for retries and pauses. Default: 60000 */
        maxDelay?: number;
        /** Maximum wait in ms honored from a valid Retry-After. Default: 60000 */
        maxRetryAfter?: number;
    };

    /** Native Undici Pool.Options or ProxyAgent.Options, overriding pool defaults.
     * Request-specific options belong in request(). Proxy headers are proxy-only.
     */
    network?: NetworkOptions;
}

/**
 * How a 429 steers an adaptive pool. One rate-limit episode — the 429 and
 * every other 429 received before its wait is over — counts once: the
 * requests already in flight when the server starts refusing must not drive
 * the concurrency to its floor all together.
 */
export interface RateLimitSignalOptions {
    /**
     * Multiplicative decrease applied to concurrency once per episode, never
     * below `adaptive.minConcurrency` and always at least one slot.
     * Must be greater than 0 and less than 1. Default: 0.5
     */
    decreaseFactor?: number;

    /**
     * Successful responses required after the last 429 before the controller
     * may grow concurrency again. A non-negative integer. Default: 10
     */
    recoveryAfter?: number;
}

/**
 * `throwOnError` is excluded from the undici passthrough: undici would reject
 * with its own ResponseStatusCodeError before the pool's error/retry policy
 * runs, silently retrying non-retryable 4xx responses.
 */
export interface RequestOptions extends Omit<Dispatcher.RequestOptions, "origin" | "path" | "method" | "body" | "headers" | "signal" | "throwOnError"> {
    method?: Dispatcher.HttpMethod;
    priority?: number;
    /** Total budget from submission; overrides the pool default. Positive finite ms. */
    maxElapsedTime?: number;
    body?: string | Buffer | Uint8Array | object | null;
    headers?: Record<string, string>;
    /**
     * Optional cancellation for the entire logical request: scheduler queue,
     * quota/minTime waits, HTTP/body download, and retry backoff. Rejections
     * preserve signal.reason; an aborted request is never retried.
     * Narrowed to AbortSignal only (undici also accepts a legacy EventEmitter
     * shape, but the retry loop's abort guards would not see it).
     */
    signal?: AbortSignal | null;

    /**
     * Shape of the resolved value. `"body"` (default) resolves with the parsed
     * body alone; `"raw"` resolves with a {@link CallPoolResponse} envelope
     * carrying status and headers as well. Error and retry semantics are
     * identical in both modes: 4xx/5xx still reject with CallPoolError.
     * Options typed as RequestOptions return T | CallPoolResponse<T> when
     * the response mode is not known at compile time.
     */
    response?: "body" | "raw";

    /**
     * Reads the response body as bytes whatever the server says it is.
     *
     * By default the shape is inferred from `Content-Type`, which leaves a
     * server that omits the header — or labels a picture as text — indistinct
     * from a textual response: the body is decoded as UTF-8 and the original
     * bytes are gone for good. A caller fetching an image, a PDF or any other
     * file knows better than the header does, and this flag says so. It also
     * suppresses the automatic JSON parsing, so `application/json` served to a
     * binary request resolves as a Buffer too.
     *
     * Error bodies (4xx/5xx) stay textual regardless: the message a failure
     * carries is meant to be read.
     */
    binary?: boolean;

    /**
     * Opt-in for reading Set-Cookie in a `"raw"` envelope. By default the
     * header is redacted everywhere so cookies can't leak through logged
     * responses; enabling this exposes it in the envelope of THIS request
     * only. Headers attached to CallPoolError stay redacted regardless.
     */
    exposeCookies?: boolean;
}

/** Resolved value of a request issued with `response: "raw"`. */
export interface CallPoolResponse<T = unknown> {
    /** HTTP status code of the final response */
    status: number;
    /** Response headers (Set-Cookie is redacted unless `exposeCookies` is set) */
    headers: Record<string, string | string[] | undefined>;
    /**
     * Body, parsed with the same rules as the default mode (JSON/text/Buffer).
     * Empty HEAD/204/205/304 responses have an undefined body, or an empty
     * Buffer with binary: true. Use T = void or T | undefined as appropriate.
     */
    body: T;
}

/** Live snapshot of the pool's scheduling state; see {@link CallPool.getStats}. */
export interface CallPoolStats {
    /** Jobs waiting in the priority queue */
    queued: number;
    /** Jobs currently executing (a retrying request still occupies its slot) */
    running: number;
    /** Current concurrency limit (dynamically tuned when adaptive is enabled) */
    concurrency: number;
    /** Milliseconds left before new attempts may start after a matching `retry.pauseCodes` response, 0 otherwise */
    pausedFor: number;
}
