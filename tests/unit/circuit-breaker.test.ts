import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import { CallPool, CallPoolTimeoutError, type CallPoolOptions, type CircuitBreakerOptions } from "../../src/index";
import { CircuitBreaker } from "../../src/circuit-breaker";

function fakeClock() { vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "Date"] }); }
function response(statusCode = 200, retryAfter?: string): Dispatcher.ResponseData {
    return { statusCode, headers: { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) }, body: { text: async () => '{"ok":true}' } } as unknown as Dispatcher.ResponseData;
}
function transport(pool: CallPool) {
    const client = (pool as unknown as { client: { request(options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> } }).client;
    return vi.spyOn(client, "request");
}
const baseUrl = "http://localhost";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("CircuitBreaker state generations", () => {
    it("uses the agreed threshold, codes, cooldown, probe concurrency and recovery defaults", async () => {
        fakeClock();
        const breaker = new CircuitBreaker({});
        for (const status of [403, 429]) {
            breaker.complete(breaker.acquire()!, status);
            expect(breaker.getState()).toBe("closed");
        }
        breaker.complete(breaker.acquire()!, 503);
        expect(breaker.getState()).toBe("open");
        expect(breaker.pausedFor()).toBe(10_000);
        expect(breaker.acquire()).toBeNull();
        await vi.advanceTimersByTimeAsync(10_000);
        const first = breaker.acquire()!;
        expect(breaker.getState()).toBe("half-open");
        expect(breaker.acquire()).toBeNull();
        breaker.complete(first, 200, undefined, true);
        expect(breaker.getState()).toBe("half-open");
        breaker.complete(breaker.acquire()!, 200, undefined, true);
        expect(breaker.getState()).toBe("closed");
        expect(breaker.acquire()).not.toBeNull();
        expect(breaker.acquire()).not.toBeNull();
    });

    it("resets consecutive failures on success, ignoring other HTTP failures", () => {
        fakeClock();
        const breaker = new CircuitBreaker({ failureThreshold: 2 });
        breaker.complete(breaker.acquire()!, 403);
        breaker.complete(breaker.acquire()!, 200, undefined, true);
        breaker.complete(breaker.acquire()!, 429);
        expect(breaker.getState()).toBe("closed");
        breaker.complete(breaker.acquire()!, 404);
        expect(breaker.getState()).toBe("closed");
        breaker.complete(breaker.acquire()!, 503);
        expect(breaker.getState()).toBe("open");
    });

    it("extends an existing open period but never shortens it with late closed-generation failures", async () => {
        fakeClock();
        const breaker = new CircuitBreaker({ failureThreshold: 1 });
        const [a, b, c] = [breaker.acquire()!, breaker.acquire()!, breaker.acquire()!];
        breaker.complete(a, 403, "1");
        await vi.advanceTimersByTimeAsync(100);
        breaker.complete(b, 429, "0.1");
        expect(breaker.pausedFor()).toBe(900);
        breaker.complete(c, 503, "2");
        expect(breaker.pausedFor()).toBe(2000);
    });

    it("ignores successes and failures from older generations after half-open starts", async () => {
        fakeClock();
        const breaker = new CircuitBreaker({ failureThreshold: 1, halfOpen: { after: 100, successThreshold: 1 } });
        const [trip, oldSuccess, oldFailure] = [breaker.acquire()!, breaker.acquire()!, breaker.acquire()!];
        breaker.complete(trip, 403);
        await vi.advanceTimersByTimeAsync(100);
        const probe = breaker.acquire()!;
        breaker.complete(oldSuccess, 200, undefined, true);
        breaker.complete(oldFailure, 403, "60");
        expect(breaker.getState()).toBe("half-open");
        expect(breaker.acquire()).toBeNull();
        breaker.complete(probe, 200, undefined, true);
        expect(breaker.getState()).toBe("closed");
    });

    it("drains already-admitted probes before closing even after enough successes", async () => {
        fakeClock();
        const breaker = new CircuitBreaker({ failureThreshold: 1, halfOpen: { after: 100, maxConcurrent: 2, successThreshold: 1 } });
        breaker.complete(breaker.acquire()!, 403);
        await vi.advanceTimersByTimeAsync(100);
        const [a, b] = [breaker.acquire()!, breaker.acquire()!];
        breaker.complete(a, 200, undefined, true);
        expect(breaker.getState()).toBe("half-open");
        expect(breaker.acquire()).toBeNull();
        breaker.complete(b, 429);
        expect(breaker.getState()).toBe("open");
        expect(breaker.pausedFor()).toBe(100);
    });

    it("reopens immediately on a failed probe and ignores late probes from that generation", async () => {
        fakeClock();
        const breaker = new CircuitBreaker({ failureThreshold: 3, halfOpen: { after: 100, maxConcurrent: 3 } });
        for (let i = 0; i < 3; i++) breaker.complete(breaker.acquire()!, 403);
        await vi.advanceTimersByTimeAsync(100);
        const [a, b, c] = [breaker.acquire()!, breaker.acquire()!, breaker.acquire()!];
        breaker.complete(a, 403);
        breaker.complete(b, 200, undefined, true);
        breaker.complete(c, 429, "60");
        expect(breaker.getState()).toBe("open");
        expect(breaker.pausedFor()).toBe(100);
        await vi.advanceTimersByTimeAsync(100);
        breaker.complete(breaker.acquire()!, 200, undefined, true);
        expect(breaker.getState()).toBe("half-open");
        breaker.complete(breaker.acquire()!, 200, undefined, true);
        expect(breaker.getState()).toBe("closed");
    });

    it("releases abandoned permissions once without counting them as recovery", async () => {
        fakeClock();
        const breaker = new CircuitBreaker({ failureThreshold: 1, halfOpen: { after: 0 } });
        breaker.complete(breaker.acquire()!, 403);
        const abandoned = breaker.acquire()!;
        breaker.complete(abandoned);
        breaker.complete(abandoned, 200, undefined, true);
        const next = breaker.acquire()!;
        expect(next).not.toBeNull();
        expect(breaker.acquire()).toBeNull();
        breaker.complete(next, 200, undefined, true);
        expect(breaker.getState()).toBe("half-open");
    });
});

describe("CallPool breaker admission", () => {
    it.each([undefined, { enabled: false }, { codes: [403] }])("keeps the breaker off without enabled:true (%j)", async circuitBreaker => {
        const pool = new CallPool({ baseUrl, circuitBreaker, retry: { delay: 0 } });
        const send = transport(pool).mockResolvedValue(response(403));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ statusCode: 403, retryable: true });
            expect(send).toHaveBeenCalledTimes(3);
            expect(pool.getStats()).toMatchObject({ pausedFor: 0, circuitBreaker: "disabled" });
        } finally { await pool.close(); }
    });

    it.each([
        [[], 403, "closed"], [[404], 403, "closed"], [[404], 404, "open"], [["5xx"], 500, "open"],
    ] as [NonNullable<CircuitBreakerOptions["codes"]>, number, string][])("replaces default circuit selectors with %j (status=%i)", async (codes, status, state) => {
        const pool = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, codes } });
        transport(pool).mockResolvedValue(response(status));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ statusCode: status });
            expect(pool.getStats().circuitBreaker).toBe(state);
        } finally { await pool.close(); }
    });

    it("rejects a waiting deadline immediately when an older in-flight failure extends the open period", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, concurrency: { limit: 2 }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1 } });
        let release!: (value: Dispatcher.ResponseData) => void;
        const send = transport(pool).mockResolvedValueOnce(response(403, "0.1"))
            .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const first = pool.request("/first").catch(error => error);
        const inFlight = pool.request("/in-flight").catch(error => error);
        try {
            expect(await first).toMatchObject({ statusCode: 403 });
            const waiting = pool.request("/waiting", { maxElapsedTime: 500 }).catch(error => error);
            await vi.advanceTimersByTimeAsync(50);
            release(response(403, "1"));
            expect(await inFlight).toMatchObject({ statusCode: 403 });
            expect(await waiting).toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally { release(response()); await pool.close(); }
    });

    it("counts retries toward the shared failure threshold, including the last attempt", async () => {
        const pool = new CallPool({ baseUrl, circuitBreaker: { enabled: true }, retry: { delay: 0 } });
        const send = transport(pool).mockResolvedValue(response(403));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ statusCode: 403 });
            expect(send).toHaveBeenCalledTimes(3);
            expect(pool.getStats().circuitBreaker).toBe("open");
            expect(pool.getStats().pausedFor).toBeGreaterThan(9900);
        } finally { await pool.close(); }
    });

    it("fails breaker-only responses but retains queued work and admits one probe at a time", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, concurrency: { limit: 5 }, retry: { codes: [] }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 100 } } });
        const releases: ((value: Dispatcher.ResponseData) => void)[] = [];
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockImplementation(() => new Promise(resolve => releases.push(resolve)));
        try {
            await expect(pool.request("/refused")).rejects.toMatchObject({ retryable: false });
            const work = Array.from({ length: 5 }, (_, i) => pool.request(`/queued-${i}`).catch(error => error));
            await vi.advanceTimersByTimeAsync(99);
            expect(send).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(1);
            expect(send).toHaveBeenCalledTimes(2);
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            releases.shift()!(response());
            await vi.advanceTimersByTimeAsync(0);
            expect(send).toHaveBeenCalledTimes(3);
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            releases.shift()!(response());
            await vi.advanceTimersByTimeAsync(0);
            expect(pool.getStats().circuitBreaker).toBe("closed");
            expect(send).toHaveBeenCalledTimes(6);
            releases.splice(0).forEach(resolve => resolve(response()));
            expect(await Promise.all(work)).toEqual(Array.from({ length: 5 }, () => ({ ok: true })));
            expect(vi.getTimerCount()).toBe(0);
        } finally { releases.splice(0).forEach(resolve => resolve(response())); await pool.close(); }
    });

    it("supports multiple concurrent probes and waits for outstanding probes before full recovery", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, concurrency: { limit: 5 }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 100, maxConcurrent: 2, successThreshold: 1 } } });
        const releases: ((value: Dispatcher.ResponseData) => void)[] = [];
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockImplementation(() => new Promise(resolve => releases.push(resolve)));
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const work = Array.from({ length: 4 }, () => pool.request("/probe").catch(error => error));
            await vi.advanceTimersByTimeAsync(100);
            expect(send).toHaveBeenCalledTimes(3);
            releases.shift()!(response());
            await vi.advanceTimersByTimeAsync(0);
            expect(send).toHaveBeenCalledTimes(3);
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            releases.shift()!(response(403));
            await vi.advanceTimersByTimeAsync(0);
            expect(pool.getStats().circuitBreaker).toBe("open");
            await vi.advanceTimersByTimeAsync(100);
            expect(send).toHaveBeenCalledTimes(5);
            releases.splice(0).forEach(resolve => resolve(response()));
            await Promise.all(work);
            expect(pool.getStats().circuitBreaker).toBe("closed");
        } finally { releases.splice(0).forEach(resolve => resolve(response())); await pool.close(); }
    });

    it.each([[10, 700], [700, 10]])("uses independent Retry-After caps (retry=%i, breaker=%i)", async (retryCap, breakerCap) => {
        fakeClock();
        const pool = new CallPool({ baseUrl, retry: { maxAttempts: 1, maxRetryAfter: retryCap }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { maxRetryAfter: breakerCap } } });
        transport(pool).mockResolvedValue(response(403, "60"));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ retryAfterMs: retryCap });
            expect(pool.getStats().pausedFor).toBe(breakerCap);
        } finally { await pool.close(); }
    });

    it.each([[80, 180], [180, 80]])("overlaps retry=%i and breaker=%i instead of adding them", async (retryCap, breakerCap) => {
        const pool = new CallPool({ baseUrl, retry: { maxRetryAfter: retryCap }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { maxRetryAfter: breakerCap, successThreshold: 1 } } });
        const send = transport(pool).mockResolvedValueOnce(response(403, "1")).mockResolvedValue(response());
        try {
            const start = performance.now();
            await expect(pool.request("/")).resolves.toEqual({ ok: true });
            expect(performance.now() - start).toBeGreaterThanOrEqual(175);
            expect(performance.now() - start).toBeLessThan(250);
            expect(send).toHaveBeenCalledTimes(2);
            expect(pool.getStats().circuitBreaker).toBe("closed");
        } finally { await pool.close(); }
    });

    it.each(["quota", "spacing"])("acquires %s only when a circuit permission can also be granted", async kind => {
        fakeClock();
        const pool = new CallPool({ baseUrl, rateLimit: { enabled: true, ...(kind === "quota" ? { quota: { max: 1, window: 300 } } : { minTime: 300 }) }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 100 } } });
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockResolvedValue(response());
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const work = pool.request("/probe");
            await vi.advanceTimersByTimeAsync(299);
            expect(send).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(1);
            await work;
            expect(send).toHaveBeenCalledTimes(2);
        } finally { await pool.close(); }
    });

    it.each(["parse", "body", "network", "non-matching HTTP"])("releases a failed %s probe without treating it as success", async kind => {
        fakeClock();
        const pool = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 0, successThreshold: 1 } } });
        const send = transport(pool).mockResolvedValueOnce(response(403));
        if (kind === "network") send.mockRejectedValueOnce(new Error("network"));
        else if (kind === "non-matching HTTP") send.mockResolvedValueOnce(response(404));
        else {
            const broken = response();
            broken.body.text = async () => { if (kind === "body") throw new Error("body"); return "{broken"; };
            send.mockResolvedValueOnce(broken);
        }
        send.mockResolvedValue(response());
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            await expect(pool.request("/broken")).rejects.toThrow();
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            await expect(pool.request("/healthy")).resolves.toEqual({ ok: true });
            expect(pool.getStats().circuitBreaker).toBe("closed");
            expect(send).toHaveBeenCalledTimes(3);
        } finally { await pool.close(); }
    });

    it("releases a cancelled probe and expires work waiting for probe capacity", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, concurrency: { limit: 3 }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 0, successThreshold: 1 } } });
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockImplementationOnce(options => new Promise((_resolve, reject) => {
            (options.signal as AbortSignal).addEventListener("abort", () => reject(new Error("wrapped abort")), { once: true });
        })).mockResolvedValue(response());
        const controller = new AbortController();
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const active = pool.request("/probe", { signal: controller.signal }).catch(error => error);
            const waiting = pool.request("/waiting", { maxElapsedTime: 50 }).catch(error => error);
            await vi.advanceTimersByTimeAsync(50);
            expect(await waiting).toBeInstanceOf(CallPoolTimeoutError);
            expect(send).toHaveBeenCalledTimes(2);
            controller.abort(null);
            expect(await active).toBeNull();
            await pool.request("/replacement");
            expect(pool.getStats().circuitBreaker).toBe("closed");
            expect(vi.getTimerCount()).toBe(0);
        } finally { controller.abort(); await pool.close(); }
    });

    it("does not count headers alone as a successful probe or exceed its capacity during body download", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, concurrency: { limit: 3 }, adaptive: { enabled: true }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 0, successThreshold: 1 } } });
        let finishBody!: (body: string) => void;
        const slow = response();
        slow.body.text = () => new Promise(resolve => { finishBody = resolve; });
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockResolvedValueOnce(slow).mockResolvedValue(response());
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const probe = pool.request("/slow-body");
            const waiting = pool.request("/waiting");
            await vi.advanceTimersByTimeAsync(0);
            expect(send).toHaveBeenCalledTimes(2);
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            finishBody('{"ok":true}');
            await Promise.all([probe, waiting]);
            expect(send).toHaveBeenCalledTimes(3);
            expect(pool.getStats().circuitBreaker).toBe("closed");
        } finally { finishBody?.('{}'); await pool.close(); }
    });

    it("releases permission if cancellation arrives between admission and dispatch", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 0, successThreshold: 1 } } });
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockResolvedValue(response());
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const controller = new AbortController();
            const aborted = pool.request("/aborted", { signal: controller.signal }).catch(error => error);
            controller.abort(null);
            expect(await aborted).toBeNull();
            await pool.request("/replacement");
            expect(send).toHaveBeenCalledTimes(2);
            expect(pool.getStats().circuitBreaker).toBe("closed");
        } finally { await pool.close(); }
    });

    it("does not spend quota during an open period longer than a quota window", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, rateLimit: { enabled: true, quota: { max: 1, window: 300 } }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 500 } } });
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockResolvedValue(response());
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const first = pool.request("/probe-1");
            const second = pool.request("/probe-2");
            await vi.advanceTimersByTimeAsync(500);
            await first;
            expect(send).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(100);
            await second;
            expect(send).toHaveBeenCalledTimes(3);
            expect(pool.getStats().circuitBreaker).toBe("closed");
        } finally { await pool.close(); }
    });

    it("closes while open, rejecting gate and scheduler waits without leaving timers", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1 } });
        const send = transport(pool).mockResolvedValue(response(403));
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const pending = [pool.request("/gate"), pool.request("/scheduler")].map(p => p.catch(error => error));
            await pool.close();
            for (const result of await Promise.all(pending)) expect(result).toMatchObject({ message: "[CallPool] Pool is closed" });
            expect(send).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally { await pool.close(); }
    });

    it("chunks very long open periods without early probes", async () => {
        fakeClock();
        const pool = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 2_600_000_000, successThreshold: 1 } } });
        const send = transport(pool).mockResolvedValueOnce(response(403)).mockResolvedValue(response());
        try {
            await expect(pool.request("/trip")).rejects.toThrow();
            const pending = pool.request("/probe");
            await vi.advanceTimersByTimeAsync(2_147_483_647);
            expect(send).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(2_600_000_000 - 2_147_483_647);
            await pending;
            expect(send).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally { await pool.close(); }
    });
});

describe("explicit configuration", () => {
    it.each([undefined, false])("does not apply quota or spacing when rateLimit.enabled is %s", async enabled => {
        fakeClock();
        const pool = new CallPool({ baseUrl, rateLimit: { enabled, minTime: 1000, quota: { max: 1, window: 5000 } } });
        const send = transport(pool).mockResolvedValue(response());
        try {
            await Promise.all([pool.request("/a"), pool.request("/b")]);
            expect(send).toHaveBeenCalledTimes(2);
            expect(performance.now()).toBe(0);
        } finally { await pool.close(); }
    });

    it.each([
        null, true, [], { enabled: "yes" }, { codes: null }, { codes: [200] }, { codes: ["3xx"] },
        { failureThreshold: 0 }, { failureThreshold: 1.5 }, { failureThreshold: Infinity },
        { halfOpen: null }, { halfOpen: [] }, { halfOpen: { after: -1 } }, { halfOpen: { after: Infinity } },
        { halfOpen: { maxRetryAfter: NaN } }, { halfOpen: { maxConcurrent: 0 } }, { halfOpen: { successThreshold: 0 } },
        { onOpen: "fail" },
    ])("rejects invalid breaker configuration %j even when disabled", config => {
        expect(() => new CallPool({ baseUrl, circuitBreaker: config as CircuitBreakerOptions })).toThrow("circuitBreaker");
    });

    it("rejects removed pauseCodes and invalid enabled flags", () => {
        expect(() => new CallPool({ baseUrl, retry: { pauseCodes: [403] } } as CallPoolOptions)).toThrow("circuitBreaker");
        expect(() => new CallPool({ baseUrl, rateLimit: { enabled: "yes" } } as unknown as CallPoolOptions)).toThrow("rateLimit.enabled");
    });

    it("accepts overlapping selectors and copies breaker codes", async () => {
        const codes = [403];
        const pool = new CallPool({ baseUrl, retry: { codes, maxAttempts: 1 }, circuitBreaker: { enabled: true, codes, failureThreshold: 1 } });
        codes.length = 0;
        transport(pool).mockResolvedValue(response(403));
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ retryable: true });
            expect(pool.getStats().circuitBreaker).toBe("open");
        } finally { await pool.close(); }
    });
});
