import { afterEach, describe, expect, it, vi } from "vitest";
import { CallPool, undiciTransport, type CallPoolOptions, type RetryContext, type Transport, type TransportRequest, type TransportResponse } from "../../src/index";

function response(statusCode = 200, body = '{"ok":true}'): TransportResponse {
    return {
        statusCode,
        headers: { "content-type": "application/json" },
        body: { text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer },
    };
}

/** A transport answering `statuses` in order (200 once they run out), recording what the pool hands it. */
function fakeTransport(statuses: Array<number | Error> = [], extra: Partial<Transport> = {}) {
    const requests: TransportRequest[] = [];
    const rotations: RetryContext[] = [];
    const close = vi.fn(async () => {});
    const transport: Transport = {
        async request(request) {
            requests.push(request);
            const next = statuses.shift() ?? 200;
            if (next instanceof Error) throw next;
            return response(next);
        },
        rotate: context => {
            rotations.push(context);
        },
        close,
        ...extra,
    };
    const factory = vi.fn(() => transport);
    return { factory, requests, rotations, close };
}

afterEach(() => vi.restoreAllMocks());

describe("transport", () => {
    it("builds the transport with the pool's origin and concurrency", async () => {
        const { factory } = fakeTransport();
        const pool = new CallPool({ baseUrl: "https://example.com/api", concurrency: { limit: 4 }, transport: factory });
        try {
            expect(factory).toHaveBeenCalledWith({ origin: "https://example.com", connections: 4 });
        } finally { await pool.close(); }
    });

    it("hands the transport the request: path, URL on the origin, merged headers, serialized body, timeout and passthrough", async () => {
        const { factory, requests } = fakeTransport();
        const pool = new CallPool({ baseUrl: "https://example.com", defaultHeaders: { "X-Default": "a", Accept: "x" }, transport: factory });
        try {
            await pool.request("/items?page=2", { method: "POST", headers: { accept: "application/json" }, body: { id: 1 }, timeout: 500, reset: true });
            const [request] = requests;
            expect(request).toMatchObject({
                path: "/items?page=2",
                method: "POST",
                headers: { "x-default": "a", accept: "application/json", "content-type": "application/json" },
                body: '{"id":1}',
                timeout: 500,
                options: { reset: true },
            });
            expect(request.url.href).toBe("https://example.com/items?page=2");
        } finally { await pool.close(); }
    });

    it("keeps a //host path on the pool's origin", async () => {
        const { factory, requests } = fakeTransport();
        const pool = new CallPool({ baseUrl: "https://example.com", transport: factory });
        try {
            await pool.request("//other.example/x");
            expect(requests[0].url.host).toBe("example.com");
            expect(requests[0].url.pathname).toBe("//other.example/x");
        } finally { await pool.close(); }
    });

    it("rotates before every retry, with the failed attempt and its status, never after a success", async () => {
        const { factory, requests, rotations } = fakeTransport([403, 503]);
        const pool = new CallPool({ baseUrl: "https://example.com", retry: { delay: 0 }, transport: factory });
        try {
            await expect(pool.request("/")).resolves.toEqual({ ok: true });
            expect(requests).toHaveLength(3);
            expect(rotations.map(({ attempt, status }) => [attempt, status])).toEqual([[1, 403], [2, 503]]);
        } finally { await pool.close(); }
    });

    it("rotates with the resolved status and with transport errors", async () => {
        const failure = new Error("socket hang up");
        const { factory, rotations } = fakeTransport([200, failure]);
        const pool = new CallPool({
            baseUrl: "https://example.com",
            retry: { delay: 0, codes: ["blocked"] },
            resolveStatus: () => (rotations.length === 0 ? "blocked" : undefined),
            transport: factory,
        });
        try {
            await pool.request("/");
            expect(rotations.map(({ status, error }) => [status, error === failure])).toEqual([["blocked", false], [undefined, true]]);
        } finally { await pool.close(); }
    });

    it("does not rotate when the failure is not retried", async () => {
        const { factory, rotations } = fakeTransport([404]);
        const pool = new CallPool({ baseUrl: "https://example.com", retry: { delay: 0 }, transport: factory });
        try {
            await expect(pool.request("/")).rejects.toMatchObject({ statusCode: 404 });
            expect(rotations).toHaveLength(0);
        } finally { await pool.close(); }
    });

    it("never retries an error the transport calls fatal", async () => {
        const fatal = new Error("bad request shape");
        const { factory, requests } = fakeTransport([fatal, fatal], { isFatal: error => error === fatal });
        const pool = new CallPool({ baseUrl: "https://example.com", retry: { delay: 0 }, transport: factory });
        try {
            await expect(pool.request("/")).rejects.toBe(fatal);
            expect(requests).toHaveLength(1);
        } finally { await pool.close(); }
    });

    it("closes the transport once the pool has drained", async () => {
        const { factory, close } = fakeTransport();
        const pool = new CallPool({ baseUrl: "https://example.com", transport: factory });
        await pool.request("/");
        await pool.close();
        expect(close).toHaveBeenCalledOnce();
    });

    it("validates transport, network and timeout", async () => {
        const { factory } = fakeTransport();
        expect(() => new CallPool({ baseUrl: "https://example.com", transport: {} } as unknown as CallPoolOptions)).toThrow("'transport' must be a transport factory");
        expect(() => new CallPool({ baseUrl: "https://example.com", transport: factory, network: { connections: 2 } })).toThrow("'network' cannot be combined with 'transport'");
        const pool = new CallPool({ baseUrl: "https://example.com", transport: factory });
        try {
            for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
                await expect(pool.request("/", { timeout })).rejects.toThrow("'timeout' must be a positive finite number");
            }
        } finally { await pool.close(); }
    });

    it("keeps network as the deprecated spelling of undiciTransport({ network })", async () => {
        const direct = new CallPool({ baseUrl: "http://localhost", network: { connections: 2 } });
        const explicit = new CallPool({ baseUrl: "http://localhost", transport: undiciTransport({ network: { connections: 2 } }) });
        await Promise.all([direct.close(), explicit.close()]);
    });
});
