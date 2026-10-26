import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import { CallPool, CallPoolError, type CallPoolOptions, type ResolveStatus } from "../../src/index";

const baseUrl = "http://localhost";
afterEach(() => { vi.restoreAllMocks(); });

function response(statusCode: number, body: string, headers: Record<string, string> = {}): Dispatcher.ResponseData {
    return {
        statusCode,
        headers: { "content-type": "text/plain", ...headers },
        body: { text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer },
    } as unknown as Dispatcher.ResponseData;
}

/** Answers the queued responses in order, repeating the last one. */
function serve(pool: CallPool, ...responses: Dispatcher.ResponseData[]) {
    return serveAfter(0, pool, ...responses);
}

function serveAfter(latency: number, pool: CallPool, ...responses: Dispatcher.ResponseData[]) {
    const client = (pool as unknown as { client: { request(options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> } }).client;
    let index = 0;
    return vi.spyOn(client, "request").mockImplementation(async () => {
        if (latency > 0) await new Promise(resolve => setTimeout(resolve, latency));
        return responses[Math.min(index++, responses.length - 1)];
    });
}

function pool(options: Omit<CallPoolOptions, "baseUrl">): CallPool {
    return new CallPool({ baseUrl, ...options });
}

const blocked: ResolveStatus = ({ body }) => (body === "ERRX-2" ? "blocked" : undefined);

describe("resolveStatus", () => {
    it("runs on every response with its real status, headers and unparsed body", async () => {
        const resolver = vi.fn<ResolveStatus>(() => undefined);
        const target = pool({ resolveStatus: resolver, retry: { maxAttempts: 1 } });
        serve(target, response(200, '{"ok":true}', { "content-type": "application/json" }), response(500, "down"));

        await expect(target.request("/")).resolves.toEqual({ ok: true });
        await expect(target.request("/")).rejects.toMatchObject({ statusCode: 500, resolvedStatus: undefined });

        expect(resolver.mock.calls.map(([seen]) => [seen.status, seen.body, seen.headers["content-type"]])).toEqual([
            [200, '{"ok":true}', "application/json"],
            [500, "down", "text/plain"],
        ]);
    });

    it("fails a 200 resolved into a name, keeping the real status", async () => {
        const target = pool({ resolveStatus: blocked });
        const transport = serve(target, response(200, "ERRX-2"));

        const error = await target.request("/").catch((err: unknown) => err);

        expect(error).toBeInstanceOf(CallPoolError);
        expect(error).toMatchObject({ statusCode: 200, resolvedStatus: "blocked", body: "ERRX-2", retryable: false });
        expect((error as Error).message).toBe("Resolved as 'blocked' (HTTP 200): ERRX-2");
        // Not in the default retry codes: one attempt only.
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it("retries a name only when retry.codes lists it", async () => {
        const target = pool({ resolveStatus: blocked, retry: { maxAttempts: 3, delay: 0, codes: ["blocked"] } });
        const transport = serve(target, response(200, "ERRX-2"), response(200, "ERRX-2"), response(200, "parcel"));

        await expect(target.request("/")).resolves.toBe("parcel");
        expect(transport).toHaveBeenCalledTimes(3);
    });

    it("opens the circuit on a name only when circuitBreaker.codes lists it", async () => {
        const listed = pool({ resolveStatus: blocked, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, codes: ["blocked"], failureThreshold: 1 } });
        const unlisted = pool({ resolveStatus: blocked, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1 } });
        serve(listed, response(200, "ERRX-2"));
        serve(unlisted, response(200, "ERRX-2"));

        await expect(listed.request("/")).rejects.toMatchObject({ resolvedStatus: "blocked" });
        await expect(unlisted.request("/")).rejects.toMatchObject({ resolvedStatus: "blocked" });

        expect(listed.getStats().circuitBreaker).toBe("open");
        expect(unlisted.getStats().circuitBreaker).toBe("closed");
        await Promise.all([listed.close(), unlisted.close()]);
    });

    it("treats a 200 resolved to 429 as a rate limit, honouring the real Retry-After", async () => {
        const target = pool({
            concurrency: { limit: 4 },
            adaptive: { enabled: true, rateLimitSignal: true },
            resolveStatus: ({ body }) => (body === "slow down" ? 429 : undefined),
        });
        const transport = serve(target, response(200, "slow down", { "retry-after": "0.05" }), response(200, "done"));

        const start = performance.now();
        await expect(target.request("/")).resolves.toBe("done");

        expect(performance.now() - start).toBeGreaterThanOrEqual(45);
        expect(transport).toHaveBeenCalledTimes(2);
        expect(target.getCurrentConcurrency()).toBe(2);
        await target.close();
    });

    it("turns a redirect into a failure", async () => {
        const target = pool({ resolveStatus: ({ status }) => (status >= 300 && status < 400 ? 401 : undefined) });
        serve(target, response(302, "", { location: "/login" }));

        await expect(target.request("/")).rejects.toMatchObject({ statusCode: 302, resolvedStatus: 401, retryable: false });
    });

    it("turns an error into a success, reporting both statuses in raw mode", async () => {
        const target = pool({ resolveStatus: ({ status }) => (status === 404 ? 200 : undefined) });
        serve(target, response(404, '{"found":false}', { "content-type": "application/json" }));

        await expect(target.request("/", { response: "raw" })).resolves.toMatchObject({ status: 404, resolvedStatus: 200, body: { found: false } });
    });

    it("leaves resolvedStatus out when the resolver returns the real status", async () => {
        const target = pool({ resolveStatus: ({ status }) => status });
        serve(target, response(200, "ok"));

        const result = await target.request("/", { response: "raw" });

        expect(result).not.toHaveProperty("resolvedStatus");
    });

    it("lets a request override the pool resolver", async () => {
        const target = pool({ resolveStatus: blocked });
        serve(target, response(200, "ERRX-2"));

        await expect(target.request("/", { resolveStatus: () => undefined })).resolves.toBe("ERRX-2");
    });

    it("never retries a resolver that throws or answers an invalid status", async () => {
        const failing = new Error("broken resolver");
        const throws = pool({ resolveStatus: () => { throw failing; }, retry: { maxAttempts: 3, delay: 0 } });
        const invalid = pool({ resolveStatus: () => 42, retry: { maxAttempts: 3, delay: 0 } });
        const thrown = serve(throws, response(200, "ok"));
        serve(invalid, response(200, "ok"));

        await expect(throws.request("/")).rejects.toMatchObject({ message: "[CallPool] 'resolveStatus' threw", cause: failing, retryable: false });
        await expect(invalid.request("/")).rejects.toThrow("[CallPool] 'resolveStatus' returned an invalid status: 42");
        expect(thrown).toHaveBeenCalledTimes(1);
    });

    it("lets adaptive feedback wait for the verdict instead of the real status", async () => {
        const resolved = pool({ adaptive: { enabled: true }, resolveStatus: blocked, retry: { maxAttempts: 1 } });
        const plain = pool({ adaptive: { enabled: true } });
        const resolvedSamples = vi.spyOn(resolved as unknown as { updateThrottleLogic(duration: number): void }, "updateThrottleLogic");
        const plainSamples = vi.spyOn(plain as unknown as { updateThrottleLogic(duration: number): void }, "updateThrottleLogic");
        // A measurable TTFB: an instant answer gives no sample at all.
        serveAfter(5, resolved, response(200, "ERRX-2"));
        serveAfter(5, plain, response(200, "ok"));

        await expect(resolved.request("/")).rejects.toMatchObject({ resolvedStatus: "blocked" });
        await plain.request("/");

        expect(resolvedSamples).not.toHaveBeenCalled();
        expect(plainSamples).toHaveBeenCalledOnce();
        await Promise.all([resolved.close(), plain.close()]);
    });

    it("validates the resolver and the named codes", () => {
        expect(() => pool({ resolveStatus: "blocked" as unknown as ResolveStatus })).toThrow("[CallPool] 'resolveStatus' must be a function");
        expect(() => pool({ retry: { codes: ["Blocked" as "blocked"] } })).toThrow("[CallPool] 'retry.codes' must be an array of HTTP error codes (400-599), '4xx', '5xx' or named statuses");
        expect(() => pool({ circuitBreaker: { enabled: true, codes: [429, "blocked", "rate_limited-2"] } })).not.toThrow();
    });
});
