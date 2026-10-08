import { afterEach, describe, expect, it, vi } from "vitest";
import { errors, type Dispatcher } from "undici";
import { CallPool, CallPoolTimeoutError, type CallPoolOptions, type StatusCodeSelector } from "../../src/index";

function response(statusCode = 200, retryAfter?: string): Dispatcher.ResponseData {
    return {
        statusCode,
        headers: { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) },
        body: { text: async () => '{"ok":true}' },
    } as unknown as Dispatcher.ResponseData;
}
function transport(pool: CallPool) {
    // Narrow Undici's overloaded method to the Promise overload used by CallPool.
    const client = (pool as unknown as { client: { request(options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> } }).client;
    return vi.spyOn(client, "request");
}
function fakeClock() {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "Date"] });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("retry selectors", () => {
    it.each([
        [undefined, 403, 3], [undefined, 408, 3], [undefined, 429, 3], [undefined, 503, 3], [undefined, 404, 1],
        [[], 429, 1], [[404], 404, 3], [[404], 500, 1], [["4xx"], 401, 3], [["4xx"], 500, 1],
        [["5xx"], 599, 3], [["5xx"], 429, 1], [[408, "5xx"], 408, 3],
    ] as [StatusCodeSelector[] | undefined, number, number][])("codes=%j, status=%i -> %i attempts", async (codes, status, attempts) => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes, delay: 0 } });
        const send = transport(pool).mockResolvedValue(response(status));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ statusCode: status, retryable: attempts === 3 });
            expect(send).toHaveBeenCalledTimes(attempts);
            expect(pool.getStats().pausedFor).toBe(0);
        } finally { await pool.close(); }
    });

    it.each(["codes"])("validates %s selectors", key => {
        for (const value of [null, 429, "5xx", [200], [600], [429.1], ["429"], ["3xx"], [NaN]]) {
            expect(() => new CallPool({ baseUrl: "http://localhost", retry: { [key]: value } } as CallPoolOptions)).toThrow(`retry.${key}`);
        }
    });

    it.each([{ maxDelay: -1 }, { maxDelay: Infinity }, { networkErrors: "yes" }])("validates %j", retry => {
        expect(() => new CallPool({ baseUrl: "http://localhost", retry } as CallPoolOptions)).toThrow();
    });

    it("copies selectors so caller mutation cannot change policy mid-run", async () => {
        const codes: StatusCodeSelector[] = [429];
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes, delay: 0 } });
        codes.length = 0;
        const send = transport(pool).mockResolvedValue(response(429));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ retryable: true });
            expect(send).toHaveBeenCalledTimes(3);
            expect(pool.getStats().pausedFor).toBe(0);
        } finally { await pool.close(); }
    });

    it.each([true, false])("networkErrors=%s is independent of empty HTTP codes", async networkErrors => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [], networkErrors, delay: 0 } });
        const failure = new errors.SocketError("socket closed");
        const send = transport(pool).mockRejectedValue(failure);
        try {
            await expect(pool.request("/")).rejects.toBe(failure);
            expect(send).toHaveBeenCalledTimes(networkErrors ? 3 : 1);
        } finally { await pool.close(); }
    });

    it.each([new errors.InvalidArgumentError("bad"), new errors.RequestAbortedError()])("never retries %s", async error => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: ["4xx", "5xx"], delay: 0 } });
        const send = transport(pool).mockRejectedValue(error);
        try {
            await expect(pool.request("/")).rejects.toBe(error);
            expect(send).toHaveBeenCalledOnce();
        } finally { await pool.close(); }
    });
});

describe("wait selection and request budgets", () => {
    it.each([undefined, "", "garbage", "-1", "Infinity", "  "])("falls back for invalid/missing Retry-After %j", async header => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [] }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 123 } } });
        transport(pool).mockResolvedValue(response(429, header));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ retryAfterMs: undefined });
            expect(pool.getStats().pausedFor).toBe(123);
        } finally { await pool.close(); }
    });

    it.each(["0", "0.25", "30", "Wed, 01 Jan 2025 00:00:02 GMT", "Tue, 31 Dec 2024 23:59:59 GMT"])("parses and caps Retry-After %j", async header => {
        fakeClock();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const expected = ["0", "Tue, 31 Dec 2024 23:59:59 GMT"].includes(header) ? 0 : header === "0.25" ? 250 : 700;
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [], maxRetryAfter: 700, maxDelay: 10 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { maxRetryAfter: 700 } } });
        transport(pool).mockResolvedValue(response(503, header));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ retryAfterMs: expected });
            expect(pool.getStats().pausedFor).toBe(expected);
        } finally { await pool.close(); }
    });

    it("uses one wait when retry and pause both match", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { delay: 1000 }, circuitBreaker: { enabled: true, failureThreshold: 1 } });
        const send = transport(pool).mockResolvedValueOnce(response(429, "0.4")).mockResolvedValue(response());
        try {
            const start = performance.now();
            await pool.request("/");
            const elapsed = performance.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(390);
            expect(elapsed).toBeLessThan(700);
            expect(send).toHaveBeenCalledTimes(2);
        } finally { await pool.close(); }
    });

    it("caps the individual exponential backoff and leaves other free slots usable", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost", concurrency: { limit: 2 }, retry: { delay: 60, factor: 10, maxDelay: 90, maxAttempts: 4 } });
        const arrivals: number[] = [];
        transport(pool).mockImplementation(async options => {
            if (options.path === "/other") return response();
            arrivals.push(performance.now());
            return response(503);
        });
        try {
            const failure = pool.request("/retrying").catch(error => error);
            await pool.request("/other");
            expect(arrivals).toHaveLength(1);
            expect(pool.getStats().pausedFor).toBe(0);
            expect(await failure).toMatchObject({ statusCode: 503 });
            const gaps = arrivals.slice(1).map((at, i) => at - arrivals[i]);
            expect(gaps[0]).toBeGreaterThanOrEqual(59);
            expect(gaps[1]).toBeGreaterThanOrEqual(89);
            expect(gaps[2]).toBeGreaterThanOrEqual(89);
            expect(gaps.every(gap => gap < 300)).toBe(true);
        } finally { await pool.close(); }
    });

    it("does not overflow long retry timers and preserves cancellation during backoff", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { delay: 2_600_000_000, maxDelay: 2_600_000_000 } });
        const send = transport(pool).mockResolvedValue(response(503));
        const controller = new AbortController();
        const reason = new Error("cancel long wait");
        try {
            const pending = pool.request("/", { signal: controller.signal }).catch(error => error);
            await new Promise(resolve => setTimeout(resolve, 20));
            controller.abort(reason);
            expect(await pending).toBe(reason);
            expect(send).toHaveBeenCalledOnce();
        } finally { controller.abort(reason); await pool.close(); }
    });

    it("overrides the pool deadline per request, including when retries are disabled", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", maxElapsedTime: 100, rateLimit: { enabled: true, minTime: 200 }, retry: { maxAttempts: 1 } });
        transport(pool).mockResolvedValue(response());
        try {
            await pool.request("/first");
            await expect(pool.request("/default")).rejects.toBeInstanceOf(CallPoolTimeoutError);
            const extended = pool.request("/extended", { maxElapsedTime: 500 });
            await vi.advanceTimersByTimeAsync(200);
            await expect(extended).resolves.toEqual({ ok: true });
            await expect(pool.request("/invalid", { maxElapsedTime: 0 })).rejects.toThrow("maxElapsedTime");
            expect(vi.getTimerCount()).toBe(0);
        } finally { await pool.close(); }
    });
});
