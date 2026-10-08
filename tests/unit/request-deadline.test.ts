import { getEventListeners, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallPool, CallPoolError, CallPoolTimeoutError } from "../../src/index";
import { RequestDeadline } from "../../src/request-deadline";

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
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
}

describe("maxElapsedTime", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([0, -1, NaN, Infinity, "1000", null])("rejects an invalid budget: %s", maxElapsedTime => {
        expect(() => new CallPool({ baseUrl: "http://localhost", maxElapsedTime: maxElapsedTime as number }))
            .toThrow("'maxElapsedTime' must be a positive finite number");
    });

    it("fails a 150-request backlog without sending it through repeated pool pauses, then recovers", async () => {
        fakeClock();
        const pool = new CallPool({
            baseUrl: "http://localhost",
            retry: { delay: 5000 },
            circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 5000 } },
            maxElapsedTime: 1000,
        });
        const send = transport(pool).mockResolvedValueOnce(response(429)).mockResolvedValue(response());
        try {
            const results = await Promise.allSettled(Array.from({ length: 150 }, (_, i) => pool.request(`/row-${i}`)));
            for (const result of results) {
                expect(result.status).toBe("rejected");
                if (result.status === "rejected") {
                    expect(result.reason).toBeInstanceOf(CallPoolTimeoutError);
                    expect(result.reason).toMatchObject({ retryable: false, maxElapsedTime: 1000 });
                }
            }
            expect(send).toHaveBeenCalledOnce();
            expect(pool.getStats()).toMatchObject({ queued: 0, running: 0, pausedFor: 5000 });
            expect(vi.getTimerCount()).toBe(0);

            // New work also fails before enqueueing while the long pause lasts.
            await expect(pool.request("/during-ban")).rejects.toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(5000);
            await expect(pool.request("/recovered")).resolves.toEqual({ ok: true });
            expect(send).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await pool.close();
        }
    });

    it("rejects a second retry wait beyond the remaining budget without draining each queued job through the breaker", async () => {
        const pool = new CallPool({
            baseUrl: "http://localhost",
            retry: { delay: 5000 },
            circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 5000 } },
            maxElapsedTime: 7000,
        });
        const send = transport(pool).mockResolvedValue(response(429));
        try {
            const startedAt = performance.now();
            const results = await Promise.allSettled(Array.from({ length: 150 }, (_, i) => pool.request(`/row-${i}`)));
            expect(results.every(result => result.status === "rejected" && result.reason instanceof CallPoolTimeoutError)).toBe(true);
            expect(performance.now() - startedAt).toBeGreaterThanOrEqual(4950);
            expect(performance.now() - startedAt).toBeLessThan(6500);
            expect(send).toHaveBeenCalledTimes(2);
            expect(pool.getStats()).toMatchObject({ queued: 0, running: 0 });
            expect(pool.getStats().pausedFor).toBeGreaterThan(4000);
        } finally {
            await pool.close();
        }
    }, 10_000);

    it.each([429, 503, 408])("fails before a %s retry wait that cannot fit, preserving the HTTP failure as cause", async status => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", maxElapsedTime: 1000, retry: { delay: 2000 } });
        const send = transport(pool).mockResolvedValue(response(status, "60"));
        try {
            const error = await pool.request("/refused").catch(error => error);
            expect(error).toBeInstanceOf(CallPoolError);
            expect(error).toBeInstanceOf(CallPoolTimeoutError);
            if (!(error instanceof CallPoolTimeoutError)) throw new Error("Expected timeout", { cause: error });
            expect(error.cause).toMatchObject({ statusCode: status });
            expect(error.retryable).toBe(false);
            expect(send).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await pool.close();
        }
    });

    it("counts scheduler queue time against the budget before the first retry", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", maxElapsedTime: 1000 });
        let release!: (value: Dispatcher.ResponseData) => void;
        const send = transport(pool)
            .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
            .mockResolvedValue(response(429, "0.5"));
        const first = pool.request("/slow-first");
        const queued = pool.request("/queued").catch(error => error);
        try {
            await vi.advanceTimersByTimeAsync(600);
            release(response());
            await first;
            expect(await queued).toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledTimes(2);
            // Only 400ms remained; rejecting didn't wait for the 500ms retry.
            expect(performance.now()).toBe(600);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            release(response());
            await Promise.allSettled([first, queued]);
            await pool.close();
        }
    });

    it("expires both an active HTTP request and the jobs queued behind it", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl: "http://localhost", maxElapsedTime: 1000 });
        const send = transport(pool).mockImplementation(options => new Promise((_resolve, reject) => {
            (options.signal as AbortSignal).addEventListener("abort", () => reject(new Error("transport abort wrapper")), { once: true });
        }));
        const first = pool.request("/hung").catch(error => error);
        const queued = pool.request("/queued").catch(error => error);
        try {
            await vi.advanceTimersByTimeAsync(999);
            expect(pool.getStats()).toMatchObject({ running: 1, queued: 1 });
            await vi.advanceTimersByTimeAsync(1);
            expect(await first).toBeInstanceOf(CallPoolTimeoutError);
            expect(await queued).toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledOnce();
            expect(pool.getStats()).toMatchObject({ running: 0, queued: 0 });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await vi.advanceTimersByTimeAsync(1000);
            await pool.close();
        }
    });

    it.each(["quota", "minTime"])("fails before waiting for %s beyond the budget", async kind => {
        fakeClock();
        const pool = new CallPool({
            baseUrl: "http://localhost",
            rateLimit: kind === "quota" ? { enabled: true, quota: { max: 1, window: 5000 } } : { enabled: true, minTime: 5000 },
            maxElapsedTime: 1000,
        });
        const send = transport(pool).mockResolvedValue(response());
        try {
            await pool.request("/first");
            await expect(pool.request("/rate-wait")).rejects.toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await pool.close();
        }
    });

    it("rechecks requests already waiting at the gate when a 429 introduces a longer pause", async () => {
        fakeClock();
        const pool = new CallPool({
            baseUrl: "http://localhost",
            concurrency: { limit: 2 },
            adaptive: { enabled: true, rateLimitSignal: true },
            rateLimit: { enabled: true, minTime: 100 },
            maxElapsedTime: 1000, retry: { maxAttempts: 1 },
            circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 5000 } },
        });
        const send = transport(pool).mockResolvedValue(response(429));
        try {
            const first = pool.request("/429").catch(error => error);
            const waiting = pool.request("/waiting").catch(error => error);
            expect(await first).toMatchObject({ statusCode: 429 });
            expect(await waiting).toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledOnce();
            expect(pool.getStats()).toMatchObject({ queued: 0, running: 0 });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await pool.close();
        }
    });

    it.each([null, new Error("caller cancelled")])("preserves caller cancellation with reason %s", async reason => {
        fakeClock();
        const controller = new AbortController();
        const pool = new CallPool({
            baseUrl: "http://localhost",
            rateLimit: { enabled: true, minTime: 500 },
            maxElapsedTime: 1000,
        });
        const send = transport(pool).mockResolvedValue(response());
        try {
            await pool.request("/first", { signal: controller.signal });
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
            const pending = pool.request("/waiting", { signal: controller.signal }).catch(error => error);
            controller.abort(reason);
            expect(await pending).toBe(reason);
            await expect(pool.request("/already-aborted", { signal: controller.signal })).rejects.toBe(reason);
            expect(send).toHaveBeenCalledOnce();
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await pool.close();
        }
    });

    it("releases deadline resources when the pool closes during a rate wait", async () => {
        fakeClock();
        const controller = new AbortController();
        const pool = new CallPool({ baseUrl: "http://localhost", rateLimit: { enabled: true, minTime: 500 }, maxElapsedTime: 1000 });
        transport(pool).mockResolvedValue(response());
        try {
            await pool.request("/first");
            const pending = pool.request("/waiting", { signal: controller.signal }).catch(error => error);
            await pool.close();
            expect(await pending).toMatchObject({ message: "[CallPool] Pool is closed" });
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await pool.close();
        }
    });

    it("keeps the closed-pool error when a long pause outlives close()", async () => {
        fakeClock();
        const pool = new CallPool({
            baseUrl: "http://localhost",
            retry: { delay: 5000 },
            circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 5000 } },
            maxElapsedTime: 1000,
        });
        transport(pool).mockResolvedValue(response(429));
        try {
            await expect(pool.request("/refused")).rejects.toBeInstanceOf(CallPoolTimeoutError);
            await pool.close();
            await expect(pool.request("/closed")).rejects.toThrow("[CallPool] Pool is closed");
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await pool.close();
        }
    });

    it("allows retries and successful response parsing within the budget", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost", maxElapsedTime: 1000, retry: { delay: 1 } });
        const send = transport(pool).mockResolvedValueOnce(response(503)).mockResolvedValue(response());
        try {
            await expect(pool.request("/eventually-ok", { response: "raw" })).resolves.toMatchObject({ status: 200, body: { ok: true } });
            expect(send).toHaveBeenCalledTimes(2);
        } finally {
            await pool.close();
        }
    });

    it.each([false, true])("cancels a real stalled HTTP response at the total deadline (headers sent: %s)", async sendHeaders => {
        let requests = 0;
        const server = createServer((_req, res) => {
            requests++;
            if (sendHeaders) {
                res.writeHead(200, { "content-type": "application/json" });
                res.write('{"ok":');
            }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const pool = new CallPool({
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            maxElapsedTime: 200,
        });
        try {
            await expect(pool.request("/stalled")).rejects.toBeInstanceOf(CallPoolTimeoutError);
            expect(requests).toBe(1);
            expect(pool.getStats()).toMatchObject({ running: 0, queued: 0 });
        } finally {
            await pool.close();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it("chunks deadlines beyond Node's maximum timer delay", async () => {
        fakeClock();
        const deadline = new RequestDeadline(2_600_000_000);
        try {
            await vi.advanceTimersByTimeAsync(2_147_483_647);
            expect(deadline.signal.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(2_600_000_000 - 2_147_483_647);
            expect(deadline.signal.reason).toBeInstanceOf(CallPoolTimeoutError);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            deadline.dispose();
        }
    });
});
