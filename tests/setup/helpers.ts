/**
 * Utility functions per i test
 */

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function waitFor(condition: () => boolean, timeout: number = 5000, interval: number = 100): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const check = () => {
            if (condition()) {
                resolve();
            } else if (Date.now() - start > timeout) {
                reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
            } else {
                setTimeout(check, interval);
            }
        };

        check();
    });
}

export function expectTiming(actual: number, expected: number, tolerance: number = 100): void {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        throw new Error(`Timing mismatch: expected ~${expected}ms, got ${actual}ms (diff: ${diff}ms)`);
    }
}

export function createMockResponse(
    body: any,
    statusCode: number = 200,
    headers: Record<string, string> = {}
): { body: any; statusCode: number; headers: Record<string, string> } {
    return {
        body: typeof body === "string" ? body : JSON.stringify(body),
        statusCode,
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
    };
}

import { performance } from "perf_hooks";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** PRNG deterministico (mulberry32) */
export function makeRng(seed = 1) {
    let t = seed >>> 0;
    return () => {
        t += 0x6d2b79f5;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

export function percentile(values: number[], p: number) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}

/** aspetta che Bottleneck svuoti coda e running (con timeout) */
export async function drainPool(pool: any, timeoutMs = 5000) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
        const counts = pool.limiter.counts();
        if (counts.QUEUED === 0 && counts.RUNNING === 0) return;
        await sleep(20);
    }
    // se non drena entro timeout, ok: non blocchiamo il test all’infinito
}

export function createCongestionModel(seed = 42) {
    const rng = makeRng(seed);
    let active = 0;

    const onStart = () => {
        active++;
    };

    const onEnd = () => {
        active = Math.max(0, active - 1);
    };

    const latency = (baseMs: number, perActiveMs: number, jitterMs: number) => {
        const jitter = (rng() * 2 - 1) * jitterMs; // [-jitter, +jitter]
        const value = baseMs + active * perActiveMs + jitter;
        return Math.max(0, Math.round(value));
    };

    // opzionale: random 429 quando sei troppo sopra una soglia
    const statusCode = (thresholdActive: number, prob: number) => {
        if (active >= thresholdActive && rng() < prob) return 429;
        return 200;
    };

    return { onStart, onEnd, latency, statusCode, getActive: () => active };
}
