import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

// A server that refuses the first `refusals` requests with 429 (+ Retry-After)
// and records when every request reached it.
async function rateLimitedServer(refusals: number, retryAfter = "1", latency = 120) {
    const server = new MockServer();
    const arrivals: number[] = [];
    const baseUrl = await server.start({
        latency,
        onRequestStart: () => arrivals.push(performance.now()),
        statusCode: () => (server.getRequestCount() <= refusals ? 429 : 200),
        headers: (): Record<string, string> =>
            server.getRequestCount() <= refusals && retryAfter ? { "Retry-After": retryAfter, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    });
    return { server, baseUrl, arrivals };
}

describe("adaptive.rateLimitSignal", () => {
    it("leaves concurrency alone on a 429 when the option is off (default)", async () => {
        const { server, baseUrl } = await rateLimitedServer(1, "0");
        const pool = new CallPool({ baseUrl, concurrency: { limit: 8 }, adaptive: { enabled: true }, retry: { maxAttempts: 2 } });
        try {
            await pool.request("/a");
            expect(pool.getCurrentConcurrency()).toBe(8);
            expect(pool.getStats().pausedFor).toBe(0);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    });

    it("cuts concurrency once per episode, however many in-flight requests get the 429", async () => {
        // The four requests in flight together are all refused: one episode.
        const { server, baseUrl } = await rateLimitedServer(4, "1");
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 8 },
            adaptive: { enabled: true, rateLimitSignal: { decreaseFactor: 0.5 } },
            retry: { maxAttempts: 2 },
        });
        try {
            await Promise.all([0, 1, 2, 3].map(i => pool.request(`/r${i}`)));
            expect(pool.getCurrentConcurrency()).toBe(4);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    }, 10_000);

    it("never cuts below minConcurrency", async () => {
        const { server, baseUrl } = await rateLimitedServer(1, "0");
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 4 },
            adaptive: { enabled: true, minConcurrency: 3, rateLimitSignal: { decreaseFactor: 0.1 } },
            retry: { maxAttempts: 2 },
        });
        try {
            await pool.request("/a");
            expect(pool.getCurrentConcurrency()).toBe(3);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    });

    it("pauses every new attempt of the pool until the Retry-After is over", async () => {
        const { server, baseUrl, arrivals } = await rateLimitedServer(1, "1", 20);
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 4 },
            adaptive: { enabled: true, rateLimitSignal: true },
            circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 5000 } },
            retry: { delay: 5000, maxAttempts: 2 },
        });
        try {
            const first = pool.request("/refused");
            // Let the 429 land before queueing the others.
            await new Promise(r => setTimeout(r, 200));
            expect(pool.getStats().pausedFor).toBeGreaterThan(500);
            await Promise.all([first, pool.request("/b"), pool.request("/c")]);

            // Nothing reached the server between the 429 and the end of the wait.
            const afterRefusal = arrivals.slice(1).map(at => at - arrivals[0]);
            expect(Math.min(...afterRefusal)).toBeGreaterThanOrEqual(950);
            expect(pool.getStats().pausedFor).toBe(0);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    }, 10_000);

    it("coordinates retry backoff with a fixed circuit cooldown on repeated refusals", async () => {
        // No Retry-After: the configured fallback doubles on repeated refusals.
        const { server, baseUrl, arrivals } = await rateLimitedServer(2, "", 5);
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 2 },
            adaptive: { enabled: true, rateLimitSignal: true },
            circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 100 } },
            retry: { delay: 100, maxAttempts: 3 },
        });
        try {
            await pool.request("/refused-twice");
            const gaps = arrivals.slice(1).map((at, i) => at - arrivals[i]);
            expect(gaps[0]).toBeGreaterThanOrEqual(100);
            expect(gaps[0]).toBeLessThan(1500);
            expect(gaps[1]).toBeGreaterThanOrEqual(200);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    }, 25_000);

    it("keeps an explicit Retry-After as-is on repeated refusals", async () => {
        const { server, baseUrl, arrivals } = await rateLimitedServer(2, "1", 5);
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 2 },
            adaptive: { enabled: true, rateLimitSignal: true },
            circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 100 } },
            retry: { delay: 100, maxAttempts: 3 },
        });
        try {
            await pool.request("/refused-twice");
            const gaps = arrivals.slice(1).map((at, i) => at - arrivals[i]);
            expect(gaps[1]).toBeGreaterThanOrEqual(950);
            expect(gaps[1]).toBeLessThan(1800);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    }, 10_000);

    it("holds growth for recoveryAfter successes after the last 429", async () => {
        // Fast responses (< ignoreBelow) would normally grow concurrency at once.
        const { server, baseUrl } = await rateLimitedServer(1, "0", 5);
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 8 },
            adaptive: { enabled: true, rateLimitSignal: { decreaseFactor: 0.5, recoveryAfter: 3 } },
            retry: { maxAttempts: 2 },
        });
        try {
            await pool.request("/refused-then-ok"); // 429 → 4, its retry is success 1
            await pool.request("/ok-2");
            expect(pool.getCurrentConcurrency()).toBe(4);
            await pool.request("/ok-3"); // third success: growth allowed again
            expect(pool.getCurrentConcurrency()).toBe(5);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    });

    it("signals even when the 429 exhausts the attempts", async () => {
        const { server, baseUrl } = await rateLimitedServer(10, "0");
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 6 },
            adaptive: { enabled: true, rateLimitSignal: {} },
            retry: { maxAttempts: 1 },
        });
        try {
            await expect(pool.request("/a")).rejects.toThrow("Rate Limit Hit (429)");
            expect(pool.getCurrentConcurrency()).toBe(3);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    });

    it("is ignored when adaptive throttling is disabled", async () => {
        const { server, baseUrl } = await rateLimitedServer(1, "0");
        const pool = new CallPool({ baseUrl, concurrency: { limit: 6 }, adaptive: { enabled: false, rateLimitSignal: true }, retry: { maxAttempts: 2 } });
        try {
            await pool.request("/a");
            expect(pool.getCurrentConcurrency()).toBe(6);
            expect(pool.getStats().pausedFor).toBe(0);
        } finally {
            await Promise.all([pool.close(), server.stop()]);
        }
    });

    it("validates its options", () => {
        const baseUrl = "http://localhost";
        const adaptive = (rateLimitSignal: unknown) => () =>
            new CallPool({ baseUrl, adaptive: { enabled: true, rateLimitSignal: rateLimitSignal as never } });
        expect(adaptive({ decreaseFactor: 1 })).toThrow("'adaptive.rateLimitSignal.decreaseFactor'");
        expect(adaptive({ decreaseFactor: 0 })).toThrow("'adaptive.rateLimitSignal.decreaseFactor'");
        expect(adaptive({ recoveryAfter: -1 })).toThrow("'adaptive.rateLimitSignal.recoveryAfter'");
        expect(adaptive({ recoveryAfter: 1.5 })).toThrow("'adaptive.rateLimitSignal.recoveryAfter'");
        expect(adaptive({ pause: "yes" })).toThrow("'adaptive.rateLimitSignal.pause'");
        expect(adaptive("on")).toThrow("'adaptive.rateLimitSignal' must be a boolean or an object");
        expect(adaptive({ decreaseFactor: 0.7, recoveryAfter: 0 })).not.toThrow();
    });
});
