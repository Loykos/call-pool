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

/** Internal: rejection for jobs refused or flushed by a closed pool. Not part of the public API. */
export class PoolClosedError extends Error {
    constructor() {
        super("[CallPool] Pool is closed");
        this.name = "Error";
    }
}
