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
        [undefined, 408, 3], [undefined, 429, 3], [undefined, 503, 3], [undefined, 404, 1],
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

    it.each(["codes", "pauseCodes"])("validates %s selectors", key => {
        for (const value of [null, 429, "5xx", [200], [600], [429.1], ["429"], ["3xx"], [NaN]]) {
            expect(() => new CallPool({ baseUrl: "http://localhost", retry: { [key]: value } } as CallPoolOptions)).toThrow(`retry.${key}`);
        }
    });

    it.each([{ maxDelay: -1 }, { maxDelay: Infinity }, { networkErrors: "yes" }])("validates %j", retry => {
        expect(() => new CallPool({ baseUrl: "http://localhost", retry } as CallPoolOptions)).toThrow();
    });

    it("copies selectors so caller mutation cannot change policy mid-run", async () => {
        const codes: StatusCodeSelector[] = [429];
        const pauseCodes: StatusCodeSelector[] = [];
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes, pauseCodes, delay: 0 } });
        codes.length = 0;
        pauseCodes.push(429);
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

describe("shared pause independent of retry and adaptive", () => {
    it("does not implicitly pause when adaptive rate-limit feedback is enabled", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", concurrency: { limit: 4 }, adaptive: { enabled: true, rateLimitSignal: true }, retry: { maxAttempts: 1 } });
        transport(pool).mockResolvedValue(response(429, "1"));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ statusCode: 429 });
            expect(pool.getCurrentConcurrency()).toBe(2);
            expect(pool.getStats().pausedFor).toBe(0);
        } finally { await pool.close(); }
    });

    it("fails the refused request immediately, retains the queue and charges only actual attempts", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [], pauseCodes: [429], delay: 500 } });
        const send = transport(pool).mockResolvedValueOnce(response(429)).mockResolvedValue(response());
        const failed = pool.request("/refused").catch(error => error);
        const queued = pool.request("/queued");
        try {
            expect(await failed).toMatchObject({ statusCode: 429, retryable: false });
            await vi.advanceTimersByTimeAsync(499);
            expect(send).toHaveBeenCalledOnce();
            expect(pool.getStats().pausedFor).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            await expect(queued).resolves.toEqual({ ok: true });
            expect(send).toHaveBeenCalledTimes(2);
            expect(pool.getStats()).toMatchObject({ queued: 0, running: 0 });
        } finally { await pool.close(); }
    });

    it.each([[429], ["5xx"]] as StatusCodeSelector[][])("pauses on the final attempt for %j", async selector => {
        fakeClock();
        const status = selector === 429 ? 429 : 503;
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { pauseCodes: [selector], maxAttempts: 1, delay: 100 } });
        transport(pool).mockResolvedValue(response(status));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ statusCode: status });
            expect(pool.getStats().pausedFor).toBe(100);
        } finally { await pool.close(); }
    });

    it("escalates once per episode, caps fallback, and resets after a subsequent success", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", concurrency: { limit: 4 }, retry: { codes: [], pauseCodes: [429], delay: 100, factor: 3, maxDelay: 500 } });
        const send = transport(pool).mockResolvedValue(response(429));
        try {
            await Promise.allSettled([pool.request("/a"), pool.request("/b"), pool.request("/c")]);
            expect(pool.getStats().pausedFor).toBe(100);
            for (const [elapsed, expected] of [[100, 300], [300, 500], [500, 500]]) {
                await vi.advanceTimersByTimeAsync(elapsed);
                await expect(pool.request("/still-banned")).rejects.toMatchObject({ statusCode: 429 });
                expect(pool.getStats().pausedFor).toBe(expected);
            }
            await vi.advanceTimersByTimeAsync(500);
            send.mockResolvedValueOnce(response());
            await pool.request("/recovered");
            await expect(pool.request("/new-episode")).rejects.toMatchObject({ statusCode: 429 });
            expect(pool.getStats().pausedFor).toBe(100);
        } finally { await pool.close(); }
    });

    it("does not abort in-flight work or let an older success reset the pause backoff", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", concurrency: { limit: 2 }, retry: { codes: [], pauseCodes: [429], delay: 100 } });
        let release!: (value: Dispatcher.ResponseData) => void;
        const send = transport(pool).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(response(429));
        const pending = pool.request("/already-running");
        try {
            await expect(pool.request("/refused")).rejects.toMatchObject({ statusCode: 429 });
            await vi.advanceTimersByTimeAsync(100);
            release(response());
            await pending;
            await expect(pool.request("/still-banned")).rejects.toMatchObject({ statusCode: 429 });
            expect(pool.getStats().pausedFor).toBe(200);
            expect(send).toHaveBeenCalledTimes(3);
        } finally { release(response()); await pool.close(); }
    });

    it("restores the configured fallback after an explicit zero wait", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [], pauseCodes: [429], delay: 100 } });
        transport(pool).mockResolvedValueOnce(response(429, "0")).mockResolvedValue(response(429));
        try {
            await expect(pool.request("/zero")).rejects.toThrow();
            expect(pool.getStats().pausedFor).toBe(0);
            await expect(pool.request("/missing-header")).rejects.toThrow();
            expect(pool.getStats().pausedFor).toBe(100);
        } finally { await pool.close(); }
    });

    it("rechecks a waiting deadline when a later in-flight refusal extends the pause", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", concurrency: { limit: 2 }, retry: { codes: [], pauseCodes: [429] } });
        let release!: (value: Dispatcher.ResponseData) => void;
        const send = transport(pool).mockResolvedValueOnce(response(429, "0.1"))
            .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const first = pool.request("/first").catch(error => error);
        const second = pool.request("/in-flight").catch(error => error);
        try {
            expect(await first).toMatchObject({ statusCode: 429 });
            const waiting = pool.request("/waiting", { maxElapsedTime: 500 }).catch(error => error);
            await vi.advanceTimersByTimeAsync(50);
            release(response(429, "1"));
            expect(await second).toMatchObject({ statusCode: 429 });
            expect(await waiting).toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally { release(response()); await pool.close(); }
    });

    it("honors explicit headers without doubling, extending but never shortening an existing pause", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", concurrency: { limit: 3 }, retry: { codes: [], pauseCodes: [429], delay: 100, maxRetryAfter: 500 } });
        const send = transport(pool).mockResolvedValueOnce(response(429, "0.5")).mockResolvedValueOnce(response(429, "0.1"));
        try {
            await Promise.allSettled([pool.request("/a"), pool.request("/b")]);
            expect(pool.getStats().pausedFor).toBe(500);
            await vi.advanceTimersByTimeAsync(500);
            send.mockResolvedValue(response(429, "0.2"));
            await expect(pool.request("/again")).rejects.toMatchObject({ retryAfterMs: 200 });
            expect(pool.getStats().pausedFor).toBe(200);
        } finally { await pool.close(); }
    });

    it.each(["quota", "spacing"])("respects %s after the shared pause", async kind => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", rateLimit: kind === "quota" ? { quota: { max: 1, window: 300 } } : { minTime: 300 }, retry: { codes: [], pauseCodes: [429], delay: 100 } });
        const send = transport(pool).mockResolvedValueOnce(response(429)).mockResolvedValue(response());
        try {
            await expect(pool.request("/refused")).rejects.toThrow();
            const next = pool.request("/next");
            await vi.advanceTimersByTimeAsync(299);
            expect(send).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(1);
            await next;
            expect(send).toHaveBeenCalledTimes(2);
        } finally { await pool.close(); }
    });

    it("cancels gate and scheduler waits during a pause and closes cleanly", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [], pauseCodes: [429], delay: 1000 } });
        const send = transport(pool).mockResolvedValue(response(429));
        try {
            await expect(pool.request("/refused")).rejects.toThrow();
            const controller = new AbortController();
            const reason = new Error("cancelled");
            const gate = pool.request("/gate", { signal: controller.signal }).catch(error => error);
            const queued = pool.request("/queued", { signal: controller.signal }).catch(error => error);
            controller.abort(reason);
            expect(await gate).toBe(reason);
            expect(await queued).toBe(reason);
            const waiting = pool.request("/close-wait").catch(error => error);
            await pool.close();
            expect(await waiting).toMatchObject({ message: "[CallPool] Pool is closed" });
            expect(send).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally { await pool.close(); }
    });
});

describe("wait selection and request budgets", () => {
    it.each([undefined, "", "garbage", "-1", "Infinity", "  "])("falls back for invalid/missing Retry-After %j", async header => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [], pauseCodes: [429], delay: 123 } });
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
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { codes: [], pauseCodes: [503], maxRetryAfter: 700, maxDelay: 10 } });
        transport(pool).mockResolvedValue(response(503, header));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ retryAfterMs: expected });
            expect(pool.getStats().pausedFor).toBe(expected);
        } finally { await pool.close(); }
    });

    it("uses one wait when retry and pause both match", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { pauseCodes: [429], delay: 1000 } });
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
        const pool = new CallPool({ baseUrl: "http://localhost", maxElapsedTime: 100, rateLimit: { minTime: 200 }, retry: { maxAttempts: 1 } });
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
