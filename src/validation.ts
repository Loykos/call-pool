import { CallPoolOptions, CallPoolTlsOptions } from "./types.js";

export function validateOptions(options: CallPoolOptions): void {
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

    validateTlsOptions(options.network?.tls);
    validateRateLimitOptions(options.rateLimit);
    validateRetryOptions(options.retry);
    validateAdaptiveOptions(options.adaptive, concurrencyLimit);
}

function validateTlsOptions(tls: CallPoolTlsOptions | undefined): void {
    if (tls === undefined) return;
    if (typeof tls !== "object" || tls === null || Array.isArray(tls)) {
        throw new Error("[CallPool] 'network.tls' must be an object");
    }

    const cas = tls.ca === undefined ? [] : Array.isArray(tls.ca) ? tls.ca : [tls.ca];
    if (Array.isArray(tls.ca) && tls.ca.length === 0) {
        throw new Error("[CallPool] 'network.tls.ca' must not be an empty array");
    }
    cas.forEach((ca, i) => validatePem(ca, Array.isArray(tls.ca) ? `network.tls.ca[${i}]` : "network.tls.ca"));

    if (tls.cert !== undefined) validatePem(tls.cert, "network.tls.cert");
    if (tls.key !== undefined) validatePem(tls.key, "network.tls.key");
    if ((tls.cert === undefined) !== (tls.key === undefined)) {
        throw new Error("[CallPool] 'network.tls.cert' and 'network.tls.key' must be provided together");
    }

    if (tls.passphrase !== undefined && typeof tls.passphrase !== "string") {
        throw new Error("[CallPool] 'network.tls.passphrase' must be a string");
    }
    if (tls.servername !== undefined && (typeof tls.servername !== "string" || tls.servername.length === 0)) {
        throw new Error("[CallPool] 'network.tls.servername' must be a non-empty string");
    }
    if (tls.rejectUnauthorized !== undefined && typeof tls.rejectUnauthorized !== "boolean") {
        throw new Error("[CallPool] 'network.tls.rejectUnauthorized' must be a boolean");
    }
}

/**
 * Guards the most common mistake: passing a file path instead of the PEM
 * content. Node would silently ignore the unparsable value and fail later
 * with an opaque handshake error.
 */
function validatePem(value: string | Buffer, field: string): void {
    if (Buffer.isBuffer(value)) {
        if (value.length === 0) throw new Error(`[CallPool] '${field}' must not be empty`);
        return;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`[CallPool] '${field}' must be a non-empty string or Buffer`);
    }
    if (!value.includes("-----BEGIN")) {
        throw new Error(`[CallPool] '${field}' must be PEM content, not a file path`);
    }
}

function validateRateLimitOptions(rateLimit: CallPoolOptions["rateLimit"]): void {
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

function validateRetryOptions(retry: CallPoolOptions["retry"]): void {
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

function validateAdaptiveOptions(adaptive: CallPoolOptions["adaptive"], concurrencyLimit: number): void {
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
