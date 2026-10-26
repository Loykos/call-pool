import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallPool, fetchTransport, TransportTimeoutError, type FetchInit, type FetchLike } from "../../src/index";

/** A Fetch-like client answering with `respond`, recording every call. */
function fakeFetch(respond: (url: string, init: FetchInit) => Response | Promise<Response> = () => Response.json({ ok: true })) {
    const calls: Array<{ url: string; init: FetchInit }> = [];
    const fetch: FetchLike = async (url, init) => {
        calls.push({ url, init });
        return respond(url, init);
    };
    return { fetch, calls };
}

/** Resolves only when the request is aborted, rejecting with the abort reason like Fetch clients do. */
function untilAborted(_url: string, init: FetchInit): Promise<Response> {
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
}

afterEach(() => vi.restoreAllMocks());

describe("fetchTransport", () => {
    it("sends the full URL with method, headers, body, manual redirects and the client's extra init", async () => {
        const { fetch, calls } = fakeFetch();
        const pool = new CallPool({ baseUrl: "https://api.example.com", transport: fetchTransport(fetch, { init: { priority: "high" } }) });
        try {
            await pool.request("/items?page=2", { method: "POST", body: { id: 1 } });
            await pool.request("/items");
            expect(calls[0].url).toBe("https://api.example.com/items?page=2");
            expect(calls[0].init).toMatchObject({ method: "POST", body: '{"id":1}', redirect: "manual", priority: "high", headers: { "content-type": "application/json" } });
            expect(calls[1].init.body).toBeNull();
        } finally { await pool.close(); }
    });

    it("reads headers in lowercase with Set-Cookie as an array, and keeps it redacted unless exposed", async () => {
        const headers = new Headers({ "Content-Type": "application/json", "X-Trace": "abc" });
        headers.append("Set-Cookie", "a=1");
        headers.append("Set-Cookie", "b=2");
        const { fetch } = fakeFetch(() => new Response('{"ok":true}', { headers }));
        const pool = new CallPool({ baseUrl: "https://api.example.com", transport: fetchTransport(fetch) });
        try {
            const exposed = await pool.request("/", { response: "raw", exposeCookies: true });
            const redacted = await pool.request("/", { response: "raw" });
            expect(exposed.headers).toMatchObject({ "content-type": "application/json", "x-trace": "abc", "set-cookie": ["a=1", "b=2"] });
            expect(redacted.headers["set-cookie"]).toBe("[redacted]");
        } finally { await pool.close(); }
    });

    it("keeps binary bodies as bytes", async () => {
        const bytes = new Uint8Array([0, 255, 128, 7]);
        const { fetch } = fakeFetch(() => new Response(bytes, { headers: { "content-type": "image/png" } }));
        const pool = new CallPool({ baseUrl: "https://api.example.com", transport: fetchTransport(fetch) });
        try {
            const body = await pool.request<Buffer>("/image.png");
            expect([...body]).toEqual([...bytes]);
        } finally { await pool.close(); }
    });

    it("aborts an attempt after `timeout`, retries it as a transport error and leaves no listener on the caller signal", async () => {
        const { fetch, calls } = fakeFetch(untilAborted);
        const pool = new CallPool({ baseUrl: "https://api.example.com", retry: { maxAttempts: 2, delay: 0 }, transport: fetchTransport(fetch) });
        const controller = new AbortController();
        try {
            await expect(pool.request("/", { timeout: 20, signal: controller.signal })).rejects.toBeInstanceOf(TransportTimeoutError);
            expect(calls).toHaveLength(2);
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        } finally { await pool.close(); }
    });

    it("stops at the caller's abort without retrying", async () => {
        const { fetch, calls } = fakeFetch(untilAborted);
        const pool = new CallPool({ baseUrl: "https://api.example.com", retry: { delay: 0 }, transport: fetchTransport(fetch) });
        const controller = new AbortController();
        const reason = new Error("stop");
        try {
            const pending = pool.request("/", { signal: controller.signal });
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            controller.abort(reason);
            await expect(pending).rejects.toBe(reason);
            expect(calls).toHaveLength(1);
        } finally { await pool.close(); }
    });

    it("builds a new client from the factory before every retry rotateOn selects", async () => {
        let built = 0;
        const statuses = [403, 503, 200];
        const create = vi.fn(() => {
            built += 1;
            const client = built;
            return fakeFetch(() => new Response(JSON.stringify({ client }), { status: statuses.shift(), headers: { "content-type": "application/json" } })).fetch;
        });
        const pool = new CallPool({
            baseUrl: "https://api.example.com",
            retry: { delay: 0 },
            transport: fetchTransport({ create }, { rotateOn: ({ status }) => status === 403 }),
        });
        try {
            await expect(pool.request("/")).resolves.toEqual({ client: 2 });
            expect(create).toHaveBeenCalledTimes(2);
        } finally { await pool.close(); }
    });

    it("retries when building a client fails, on the next client", async () => {
        let builds = 0;
        const create = () => {
            builds += 1;
            if (builds === 1) throw new Error("proxy session unavailable");
            return fakeFetch().fetch;
        };
        const pool = new CallPool({ baseUrl: "https://api.example.com", retry: { delay: 0 }, transport: fetchTransport({ create }) });
        try {
            await expect(pool.request("/")).resolves.toEqual({ ok: true });
            expect(builds).toBe(2);
        } finally { await pool.close(); }
    });

    it("never retries a path that is no URL, or an error the client calls fatal", async () => {
        const fatal = new Error("unsupported option");
        const { fetch, calls } = fakeFetch(() => { throw fatal; });
        const pool = new CallPool({ baseUrl: "https://api.example.com", retry: { delay: 0 }, transport: fetchTransport(fetch, { isFatal: error => error === fatal }) });
        try {
            await expect(pool.request("http://[bad")).rejects.toMatchObject({ code: "ERR_INVALID_URL" });
            await expect(pool.request("/")).rejects.toBe(fatal);
            expect(calls).toHaveLength(1);
        } finally { await pool.close(); }
    });

    it("releases the client when the pool closes", async () => {
        const close = vi.fn();
        const pool = new CallPool({ baseUrl: "https://api.example.com", transport: fetchTransport(fakeFetch().fetch, { close }) });
        await pool.close();
        expect(close).toHaveBeenCalledOnce();
    });
});
