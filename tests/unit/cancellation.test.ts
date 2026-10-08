import { getEventListeners, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallPool } from "../../src/index";
import { RequestScheduler } from "../../src/scheduler";
import { RateGate } from "../../src/rate-gate";
import type { Dispatcher, Pool } from "undici";

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function response(statusCode = 200): Dispatcher.ResponseData {
    return {
        statusCode,
        headers: { "content-type": "application/json" },
        body: { text: async () => '{"ok":true}' },
    } as Dispatcher.ResponseData;
}

function transport(pool: CallPool) {
    return vi.spyOn((pool as unknown as { client: Pool }).client, "request");
}

describe("Cancellation", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("removes queued jobs immediately, preserving priority and FIFO for survivors", async () => {
        const scheduler = new RequestScheduler({ maxConcurrent: 0 });
        const controller = new AbortController();
        const reason = new Error("Cancelled in queue");
        const order: string[] = [];
        const cancelledTask = vi.fn(async () => order.push("cancelled"));
        const cancelled = scheduler.schedule(0, cancelledTask, controller.signal).catch(error => error);
        const jobs = [
            scheduler.schedule(5, async () => order.push("normal")),
            scheduler.schedule(1, async () => order.push("first")),
            scheduler.schedule(1, async () => order.push("second")),
        ];
        try {
            controller.abort(reason);
            expect(scheduler.queued).toBe(3);
            expect(await cancelled).toBe(reason);
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
            scheduler.setMaxConcurrent(1);
            await Promise.all(jobs);
            expect(order).toEqual(["first", "second", "normal"]);
            expect(cancelledTask).not.toHaveBeenCalled();
        } finally {
            scheduler.setMaxConcurrent(1);
            await Promise.allSettled([cancelled, ...jobs]);
            await scheduler.stop();
        }
    });

    it("does not enqueue an already-aborted signal even when no slot is available", async () => {
        const scheduler = new RequestScheduler({ maxConcurrent: 0 });
        const controller = new AbortController();
        controller.abort(null);
        const task = vi.fn(async () => {});
        const result = scheduler.schedule(5, task, controller.signal).catch(error => error);
        try {
            expect(scheduler.queued).toBe(0);
            expect(await result).toBeNull();
            expect(task).not.toHaveBeenCalled();
        } finally {
            await scheduler.stop();
        }
    });

    it("removes the queue listener on dispatch and holds the slot until the task settles", async () => {
        const scheduler = new RequestScheduler({ maxConcurrent: 1 });
        const controller = new AbortController();
        const active = deferred();
        const first = scheduler.schedule(5, () => active.promise, controller.signal);
        const nextTask = vi.fn(async () => {});
        const second = scheduler.schedule(5, nextTask);
        try {
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
            controller.abort();
            expect(scheduler.running).toBe(1);
            expect(nextTask).not.toHaveBeenCalled();
            active.resolve();
            await Promise.all([first, second]);
            expect(nextTask).toHaveBeenCalledOnce();
        } finally {
            active.resolve();
            await Promise.allSettled([first, second]);
            await scheduler.stop();
        }
    });

    it.each(["abort-first", "close-first"])("settles a queued job once on %s and removes its listener", async ordering => {
        const scheduler = new RequestScheduler({ maxConcurrent: 0 });
        const controller = new AbortController();
        const reason = new Error("cancelled");
        const rejected = vi.fn();
        const result = scheduler.schedule(5, async () => {}, controller.signal).catch(rejected);
        if (ordering === "abort-first") controller.abort(reason);
        await scheduler.stop();
        controller.abort(reason);
        await result;
        expect(rejected).toHaveBeenCalledOnce();
        expect(rejected.mock.calls[0][0]).toEqual(ordering === "abort-first" ? reason : expect.objectContaining({ message: "[CallPool] Pool is closed" }));
        expect(scheduler.queued).toBe(0);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });

    it.each([
        { name: "quota", minTime: 0, quota: { max: 1, window: 1000 } },
        { name: "minTime", minTime: 1000 },
    ])("cancels a $name waiter without charging the next permission", async ({ minTime, quota }) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const gate = new RateGate({ minTime, quota });
        const controller = new AbortController();
        const reason = new Error("cancel quota wait");
        await gate.acquire();
        const rejected = vi.fn();
        const cancelled = gate.acquire(controller.signal).catch(rejected);
        const granted = vi.fn();
        const next = gate.acquire().then(granted);
        try {
            controller.abort(reason);
            await vi.advanceTimersByTimeAsync(0);
            expect(rejected).toHaveBeenCalledExactlyOnceWith(reason);
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(999);
            expect(granted).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(granted).toHaveBeenCalledOnce();
        } finally {
            gate.stop();
            await Promise.allSettled([cancelled, next]);
        }
    });

    it("cancels the last rate waiter, clears its wake timer, and keeps spacing for new work", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const gate = new RateGate({ minTime: 1000 });
        const controller = new AbortController();
        await gate.acquire();
        const cancelled = gate.acquire(controller.signal).catch(error => error);
        try {
            expect(vi.getTimerCount()).toBe(1);
            controller.abort();
            expect(vi.getTimerCount()).toBe(0);
            await cancelled;
            const granted = vi.fn();
            const next = gate.acquire().then(granted);
            await vi.advanceTimersByTimeAsync(999);
            expect(granted).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await next;
            expect(granted).toHaveBeenCalledOnce();
        } finally {
            gate.stop();
        }
    });

    it("does not charge an already-aborted acquire and removes listeners on grant and stop", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const gate = new RateGate({ minTime: 1000 });
        const aborted = new AbortController();
        const granted = new AbortController();
        const waiting = new AbortController();
        aborted.abort("cancelled");
        try {
            await expect(gate.acquire(aborted.signal)).rejects.toBe("cancelled");
            await gate.acquire(granted.signal);
            expect(getEventListeners(granted.signal, "abort")).toHaveLength(0);
            const result = gate.acquire(waiting.signal).catch(error => error);
            expect(getEventListeners(waiting.signal, "abort")).toHaveLength(1);
            gate.stop();
            await expect(result).resolves.toMatchObject({ message: "[CallPool] Pool is closed" });
            expect(getEventListeners(waiting.signal, "abort")).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            gate.stop();
        }
    });

    it("cancels through the public API while another request owns the only slot", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost" });
        const active = deferred<Dispatcher.ResponseData>();
        const request = transport(pool).mockReturnValueOnce(active.promise);
        const controller = new AbortController();
        const reason = new Error("no longer needed");
        const first = pool.request("/active");
        const cancelled = pool.request("/queued", { signal: controller.signal }).catch(error => error);
        try {
            controller.abort(reason);
            expect(pool.getStats()).toMatchObject({ queued: 0, running: 1 });
            expect(await cancelled).toBe(reason);
            expect(request).toHaveBeenCalledOnce();
        } finally {
            active.resolve(response());
            await Promise.allSettled([first, cancelled]);
            await pool.close();
        }
    });

    it("releases a quota-waiting slot without sending HTTP or consuming the next quota", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const pool = new CallPool({ baseUrl: "http://localhost", rateLimit: { enabled: true, quota: { max: 1, window: 1000 } } });
        const request = transport(pool).mockResolvedValue(response());
        const controller = new AbortController();
        const reason = new Error("cancel quota wait");
        await pool.request("/first");
        const rejected = vi.fn();
        const cancelled = pool.request("/cancelled", { signal: controller.signal }).catch(rejected);
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(pool.getStats().running).toBe(1);
            controller.abort(reason);
            await vi.advanceTimersByTimeAsync(0);
            expect(rejected).toHaveBeenCalledExactlyOnceWith(reason);
            expect(pool.getStats()).toMatchObject({ queued: 0, running: 0 });
            expect(request).toHaveBeenCalledOnce();
            const next = pool.request("/next");
            await vi.advanceTimersByTimeAsync(1000);
            await next;
            expect(request).toHaveBeenCalledTimes(2);
        } finally {
            await pool.close();
            await cancelled;
        }
    });

    it.each(["headers", "body"])("holds the HTTP slot until cancellation settles during %s", async phase => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { maxAttempts: 3 } });
        const controller = new AbortController();
        const reason = new Error("cancel active HTTP");
        const active = deferred<never>();
        const started = deferred();
        const request = transport(pool).mockImplementationOnce(async () => {
            if (phase === "headers") {
                started.resolve();
                return active.promise;
            }
            return { ...response(), body: { text: () => { started.resolve(); return active.promise; } } } as Dispatcher.ResponseData;
        }).mockResolvedValue(response());
        const first = pool.request("/active", { signal: controller.signal }).catch(error => error);
        const next = pool.request("/next");
        try {
            await started.promise;
            controller.abort(reason);
            expect(request.mock.calls[0][0].signal).toBe(controller.signal);
            expect(pool.getStats()).toMatchObject({ running: 1, queued: 1 });
            expect(request).toHaveBeenCalledOnce();
            // The transport observes abort, then completes its own teardown.
            active.reject(new Error("transport abort wrapper"));
            expect(await first).toBe(reason);
            await next;
            expect(request).toHaveBeenCalledTimes(2);
        } finally {
            active.reject(reason);
            await Promise.allSettled([first, next]);
            await pool.close();
        }
    });

    it("does not send HTTP when abort arrives between a quota grant and its continuation", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost", rateLimit: { enabled: true, quota: { max: 1, window: 1000 } } });
        const request = transport(pool).mockResolvedValue(response());
        const controller = new AbortController();
        const reason = new Error("cancel before HTTP");
        const result = pool.request("/cancelled", { signal: controller.signal }).catch(error => error);
        try {
            controller.abort(reason);
            expect(await result).toBe(reason);
            expect(request).not.toHaveBeenCalled();
        } finally {
            await pool.close();
        }
    });

    it("cancels backoff promptly with the original reason and no further attempts", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost", retry: { maxAttempts: 3, delay: 60_000 } });
        const request = transport(pool).mockResolvedValue(response(503));
        const controller = new AbortController();
        const reason = new Error("cancel retry");
        const result = pool.request("/retry", { signal: controller.signal }).catch(error => error);
        try {
            // Only microtasks separate the stubbed HTTP response from backoff.
            for (let tick = 0; tick < 20; tick++) await Promise.resolve();
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
            controller.abort(reason);
            expect(await result).toBe(reason);
            expect(request).toHaveBeenCalledOnce();
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        } finally {
            controller.abort(reason);
            await result;
            await pool.close();
        }
    });

    it("also cancels quota waits entered by a retry", async () => {
        const pool = new CallPool({
            baseUrl: "http://localhost",
            rateLimit: { enabled: true, quota: { max: 1, window: 60_000 } },
            retry: { maxAttempts: 3, delay: 1 },
        });
        const request = transport(pool).mockResolvedValue(response(503));
        const gate = (pool as unknown as { rateGate: RateGate }).rateGate;
        const acquire = gate.acquire.bind(gate);
        const retryWaiting = deferred();
        let attempts = 0;
        vi.spyOn(gate, "acquire").mockImplementation(signal => {
            const result = acquire(signal);
            if (++attempts === 2) retryWaiting.resolve();
            return result;
        });
        const controller = new AbortController();
        const reason = new Error("cancel retry quota");
        const result = pool.request("/retry", { signal: controller.signal }).catch(error => error);
        try {
            await retryWaiting.promise;
            controller.abort(reason);
            expect(await result).toBe(reason);
            expect(request).toHaveBeenCalledOnce();
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        } finally {
            controller.abort(reason);
            await result;
            await pool.close();
        }
    });

    it.each([false, true])("cancels a real body download without retrying (binary=%s)", async binary => {
        const bodyStarted = deferred();
        const responseClosed = deferred();
        let requests = 0;
        const server = createServer((_req, res) => {
            requests++;
            res.on("close", () => responseClosed.resolve());
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"ok":');
            bodyStarted.resolve();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const pool = new CallPool({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
        const controller = new AbortController();
        const reason = new Error("cancel download");
        // Observe the body-reader boundary, not just the server's write: this
        // verifies cancellation after headers have reached CallPool.
        const readingBody = deferred();
        const client = (pool as unknown as { client: Pool }).client;
        const send = client.request.bind(client);
        vi.spyOn(client, "request").mockImplementation(async options => {
            const res = await send(options);
            if (binary) {
                const read = res.body.arrayBuffer.bind(res.body);
                vi.spyOn(res.body, "arrayBuffer").mockImplementation(() => { readingBody.resolve(); return read(); });
            } else {
                const read = res.body.text.bind(res.body);
                vi.spyOn(res.body, "text").mockImplementation(() => { readingBody.resolve(); return read(); });
            }
            return res;
        });
        const result = pool.request("/stream", { signal: controller.signal, binary }).catch(error => error);
        try {
            await bodyStarted.promise;
            await readingBody.promise;
            controller.abort(reason);
            expect(await result).toBe(reason);
            await responseClosed.promise;
            expect(requests).toBe(1);
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        } finally {
            controller.abort(reason);
            await result;
            await pool.close();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});
