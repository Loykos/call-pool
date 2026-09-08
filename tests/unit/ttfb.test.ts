import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher, Pool } from "undici";
import { CallPool, CallPoolError } from "../../src/index";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function controlledPool({ useTTFB = true, status = 200, bodyError }: {
    useTTFB?: boolean;
    status?: number;
    bodyError?: Error;
} = {}) {
    const readingBody = deferred();
    const releaseBody = deferred();
    const payload = '{"ok":true}';
    const pool = new CallPool({
        baseUrl: "http://localhost",
        concurrency: { limit: 3 },
        adaptive: { enabled: true, useTTFB, initialConcurrency: 1, ignoreBelow: 10_000 },
        retry: { maxAttempts: 1 },
    });
    const read = async () => {
        readingBody.resolve();
        await releaseBody.promise;
        if (bodyError) throw bodyError;
        return payload;
    };
    // Only the transport is stubbed; the scheduler and adaptive controller are real.
    const client = (pool as unknown as { client: Pool }).client;
    const transport = vi.spyOn(client, "request").mockResolvedValue({
        statusCode: status,
        headers: { "content-type": "application/json" },
        body: {
            text: read,
            arrayBuffer: async () => new TextEncoder().encode(await read()).buffer,
        },
    } as unknown as Dispatcher.ResponseData);
    return { pool, readingBody, releaseBody, transport, payload };
}

describe("Adaptive response timing", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        { useTTFB: true, binary: false },
        { useTTFB: true, binary: true },
        { useTTFB: false, binary: false },
        { useTTFB: false, binary: true },
    ])("updates once at the selected boundary: $useTTFB TTFB, $binary binary", async ({ useTTFB, binary }) => {
        const { pool, readingBody, releaseBody, payload } = controlledPool({ useTTFB });
        const request = pool.request("/slow-body", { binary });
        try {
            await readingBody.promise;
            expect(pool.getCurrentConcurrency()).toBe(useTTFB ? 2 : 1);
            expect(pool.getStats().running).toBe(1);

            releaseBody.resolve();
            await expect(request).resolves.toEqual(binary ? Buffer.from(payload) : { ok: true });
            // A second sample at body completion would increase this to 3.
            expect(pool.getCurrentConcurrency()).toBe(2);
        } finally {
            releaseBody.resolve();
            await request.catch(() => {});
            await pool.close();
        }
    });

    it("starts queued work while the first response body is still pending", async () => {
        const { pool, readingBody, releaseBody, transport } = controlledPool();
        const first = pool.request("/first");
        const second = pool.request("/second");
        try {
            await readingBody.promise;
            expect(transport).toHaveBeenCalledTimes(2);
            expect(pool.getStats()).toMatchObject({ running: 2, queued: 0 });
        } finally {
            releaseBody.resolve();
            await Promise.allSettled([first, second]);
            await pool.close();
        }
    });

    it.each([400, 429, 503])("does not adapt on HTTP %i headers or body", async status => {
        const { pool, readingBody, releaseBody } = controlledPool({ status });
        const result = pool.request("/failure").catch(error => error);
        try {
            await readingBody.promise;
            expect(pool.getCurrentConcurrency()).toBe(1);
            releaseBody.resolve();
            expect(await result).toBeInstanceOf(CallPoolError);
            expect(pool.getCurrentConcurrency()).toBe(1);
        } finally {
            releaseBody.resolve();
            await result;
            await pool.close();
        }
    });

    it.each([true, false])("handles a later body failure with useTTFB=%s", async useTTFB => {
        const bodyError = new Error("Body download failed");
        const { pool, readingBody, releaseBody } = controlledPool({ useTTFB, bodyError });
        const result = pool.request("/broken-body").catch(error => error);
        try {
            await readingBody.promise;
            expect(pool.getCurrentConcurrency()).toBe(useTTFB ? 2 : 1);
            releaseBody.resolve();
            expect(await result).toBe(bodyError);
            expect(pool.getCurrentConcurrency()).toBe(useTTFB ? 2 : 1);
        } finally {
            releaseBody.resolve();
            await result;
            await pool.close();
        }
    });
});
