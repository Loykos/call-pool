import { Dispatcher } from "undici";

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
        /**
         * TLS settings for this pool's connections. Scoped to this pool only:
         * the process-wide trust store is never touched, so every other
         * connection in the process keeps validating against the system CAs.
         */
        tls?: CallPoolTlsOptions;
    };
}

/**
 * TLS settings applied to the pool's connections.
 *
 * Certificates and keys are passed as PEM **content**, not as file paths:
 * read them yourself (e.g. `readFileSync(path, "utf8")`) so the caller stays
 * in control of how they are loaded.
 */
export interface CallPoolTlsOptions {
    /**
     * Additional CA certificate(s) trusted by this pool, in PEM format.
     * Replaces the default CA bundle for these connections, so include every
     * certificate needed to complete the chain.
     */
    ca?: string | Buffer | Array<string | Buffer>;

    /** Client certificate (PEM) for mutual TLS. Requires `key`. */
    cert?: string | Buffer;

    /** Private key (PEM) for mutual TLS. Requires `cert`. */
    key?: string | Buffer;

    /** Passphrase decrypting an encrypted `key` */
    passphrase?: string;

    /** SNI hostname, when it differs from the host in `baseUrl` */
    servername?: string;

    /**
     * Whether the server certificate must validate. Default: `true`.
     * Setting this to `false` disables certificate verification entirely and
     * exposes the connection to interception: use it only against a local or
     * disposable environment, never to work around a chain that a proper `ca`
     * would fix.
     */
    rejectUnauthorized?: boolean;
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

/** Live snapshot of the pool's scheduling state; see {@link CallPool.getStats}. */
export interface CallPoolStats {
    /** Jobs waiting in the priority queue */
    queued: number;
    /** Jobs currently executing (a retrying request still occupies its slot) */
    running: number;
    /** Current concurrency limit (dynamically tuned when adaptive is enabled) */
    concurrency: number;
}
