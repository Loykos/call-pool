import { CallPoolOptions, StatusCodeSelector } from "./types.js";

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

    validateMaxElapsedTime(options.maxElapsedTime);
    // Removed aliases must not silently bypass proxy/TLS/timeout configuration
    // for JavaScript consumers migrating from 0.7.
    for (const key of ["timeout", "defaultHeaders", "tls", "proxy"]) {
        if (options.network && key in options.network) {
            throw new Error(`[CallPool] 'network.${key}' was removed in 0.8; use native Undici options (see migration guide)`);
        }
    }
    if (options.retry && "maxElapsedTime" in options.retry) {
        throw new Error("[CallPool] 'retry.maxElapsedTime' moved to 'maxElapsedTime'");
    }
    validateRateLimitOptions(options.rateLimit);
    validateRetryOptions(options.retry);
    validateAdaptiveOptions(options.adaptive, concurrencyLimit);
    validateCircuitBreaker(options.circuitBreaker);
}

export function validateMaxElapsedTime(value: number | undefined): void {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error("[CallPool] 'maxElapsedTime' must be a positive finite number");
    }
}

function validateCodes(codes: readonly StatusCodeSelector[] | undefined, field: string): void {
    if (codes === undefined) return;
    if (!Array.isArray(codes) || codes.some(code => code !== "4xx" && code !== "5xx" &&
        (!Number.isInteger(code) || code < 400 || code > 599))) {
        throw new Error(`[CallPool] '${field}' must be an array of HTTP error codes (400-599), '4xx' or '5xx'`);
    }
}

function validateRateLimitOptions(rateLimit: CallPoolOptions["rateLimit"]): void {
    if (rateLimit?.enabled !== undefined && typeof rateLimit.enabled !== "boolean") {
        throw new Error("[CallPool] 'rateLimit.enabled' must be a boolean");
    }
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
    if (retry?.maxDelay !== undefined && (!Number.isFinite(retry.maxDelay) || retry.maxDelay < 0)) {
        throw new Error("[CallPool] 'retry.maxDelay' must be a non-negative number");
    }
    if (retry?.networkErrors !== undefined && typeof retry.networkErrors !== "boolean") {
        throw new Error("[CallPool] 'retry.networkErrors' must be a boolean");
    }
    validateCodes(retry?.codes, "retry.codes");
    if (retry && "pauseCodes" in retry) {
        throw new Error("[CallPool] 'retry.pauseCodes' was replaced by 'circuitBreaker'");
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
    validateRateLimitSignal(adaptive.rateLimitSignal);
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

function validateRateLimitSignal(signal: NonNullable<CallPoolOptions["adaptive"]>["rateLimitSignal"]): void {
    if (signal === undefined || typeof signal === "boolean") return;
    if (typeof signal !== "object" || signal === null || Array.isArray(signal)) {
        throw new Error("[CallPool] 'adaptive.rateLimitSignal' must be a boolean or an object");
    }
    const { decreaseFactor, recoveryAfter } = signal;
    if (decreaseFactor !== undefined && (!Number.isFinite(decreaseFactor) || decreaseFactor <= 0 || decreaseFactor >= 1)) {
        throw new Error("[CallPool] 'adaptive.rateLimitSignal.decreaseFactor' must be greater than 0 and less than 1");
    }
    if ("pause" in signal) {
        throw new Error("[CallPool] 'adaptive.rateLimitSignal.pause' was replaced by 'circuitBreaker'");
    }
    if (recoveryAfter !== undefined && (!Number.isInteger(recoveryAfter) || recoveryAfter < 0)) {
        throw new Error("[CallPool] 'adaptive.rateLimitSignal.recoveryAfter' must be a non-negative integer");
    }
}

function validateCircuitBreaker(value: CallPoolOptions["circuitBreaker"]): void {
    if (value === undefined) return;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("[CallPool] 'circuitBreaker' must be an object");
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
        throw new Error("[CallPool] 'circuitBreaker.enabled' must be a boolean");
    }
    if ("onOpen" in value) throw new Error("[CallPool] 'circuitBreaker.onOpen' is not supported; open circuits always wait");
    validateCodes(value.codes, "circuitBreaker.codes");
    const halfOpen = value.halfOpen;
    if (halfOpen !== undefined && (typeof halfOpen !== "object" || halfOpen === null || Array.isArray(halfOpen))) {
        throw new Error("[CallPool] 'circuitBreaker.halfOpen' must be an object");
    }
    for (const [field, number] of [["failureThreshold", value.failureThreshold], ["halfOpen.maxConcurrent", halfOpen?.maxConcurrent], ["halfOpen.successThreshold", halfOpen?.successThreshold]] as const) {
        if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
            throw new Error(`[CallPool] 'circuitBreaker.${field}' must be a positive integer`);
        }
    }
    for (const [field, number] of [["after", halfOpen?.after], ["maxRetryAfter", halfOpen?.maxRetryAfter]] as const) {
        if (number !== undefined && (!Number.isFinite(number) || number < 0)) {
            throw new Error(`[CallPool] 'circuitBreaker.halfOpen.${field}' must be a non-negative finite number`);
        }
    }
}
