import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallPool, CallPoolError, CallPoolTimeoutError, fetchTransport, undiciTransport, type TransportFactory } from "../../src/index";
import { impitTransport } from "../../src/transports/impit";

/** A local server with one route per behavior the contract checks. */
function startServer(): Promise<{ server: Server; baseUrl: string; active: () => number }> {
    let flaky = 0;
    let open = 0;
    const server = createServer((req, res) => {
        open += 1;
        res.on("close", () => { open -= 1; });
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => {
            const url = new URL(req.url ?? "/", "http://localhost");
            switch (url.pathname) {
                case "/json":
                    res.setHeader("content-type", "application/json");
                    return res.end(JSON.stringify({ ok: true, query: url.searchParams.get("q") }));
                case "/echo":
                    res.setHeader("content-type", "application/json");
                    return res.end(JSON.stringify({ method: req.method, header: req.headers["x-test"], body: Buffer.concat(chunks).toString() }));
                case "/cookies":
                    res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
                    res.setHeader("content-type", "text/plain");
                    return res.end("cookies");
                case "/binary":
                    res.setHeader("content-type", "application/octet-stream");
                    return res.end(Buffer.from([0, 255, 128, 7]));
                case "/redirect":
                    res.statusCode = 302;
                    res.setHeader("location", "/json");
                    return res.end();
                case "/flaky":
                    res.statusCode = flaky++ % 2 === 0 ? 503 : 200;
                    res.setHeader("content-type", "text/plain");
                    return res.end(String(res.statusCode));
                case "/slow":
                    setTimeout(() => res.end("late"), Number(url.searchParams.get("ms") ?? 3_000));
                    return;
                case "/slow-body": {
                    const sendHeaders = () => {
                        res.writeHead(200, { "content-type": "text/plain" });
                        res.write("first");
                    };
                    const headersMs = Number(url.searchParams.get("headersMs") ?? 0);
                    const headersTimer = headersMs > 0 ? setTimeout(sendHeaders, headersMs) : undefined;
                    if (headersMs === 0) sendHeaders();
                    const bodyTimer = setTimeout(() => res.end("last"), Number(url.searchParams.get("ms") ?? 400));
                    res.once("close", () => {
                        clearTimeout(headersTimer);
                        clearTimeout(bodyTimer);
                    });
                    return;
                }
                default:
                    res.statusCode = 404;
                    return res.end("not found");
            }
        });
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
        resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, active: () => open });
    }));
}

const TRANSPORTS: Array<[string, () => TransportFactory]> = [
    ["undiciTransport", () => undiciTransport()],
    ["fetchTransport (global fetch)", () => fetchTransport(fetch)],
    ["impitTransport", () => impitTransport({ browser: "chrome" })],
];

describe.each(TRANSPORTS)("transport contract: %s", (_name, transport) => {
    let server: Server;
    let baseUrl: string;
    let active: () => number;
    let pool: CallPool;

    beforeAll(async () => {
        ({ server, baseUrl, active } = await startServer());
        pool = new CallPool({ baseUrl, concurrency: { limit: 2 }, retry: { delay: 0 }, transport: transport() });
    });

    afterAll(async () => {
        await pool.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    it("parses a JSON body with the query string", async () => {
        await expect(pool.request("/json?q=1")).resolves.toEqual({ ok: true, query: "1" });
    });

    it("sends method, headers and a serialized body", async () => {
        await expect(pool.request("/echo", { method: "POST", headers: { "x-test": "yes" }, body: { id: 1 } })).resolves.toEqual({ method: "POST", header: "yes", body: '{"id":1}' });
    });

    it("exposes every Set-Cookie only when asked", async () => {
        const exposed = await pool.request("/cookies", { response: "raw", exposeCookies: true });
        expect(exposed.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
        const redacted = await pool.request("/cookies", { response: "raw" });
        expect(redacted.headers["set-cookie"]).toBe("[redacted]");
    });

    it("keeps binary bodies as bytes", async () => {
        const body = await pool.request<Buffer>("/binary");
        expect([...body]).toEqual([0, 255, 128, 7]);
    });

    it("does not follow redirects", async () => {
        const response = await pool.request("/redirect", { response: "raw" });
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/json");
    });

    it("retries a 503 through the pool's policy", async () => {
        await expect(pool.request("/flaky")).resolves.toBe("200");
    });

    // Undici checks header and body timeouts on ~1 s ticks: the bound is loose on purpose
    it("fails an attempt past `timeout`", async () => {
        const single = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, transport: transport() });
        const started = performance.now();
        try {
            await expect(single.request("/slow", { timeout: 50 })).rejects.toBeDefined();
            expect(performance.now() - started).toBeLessThan(2_500);
            // The exchange itself ends, not only the promise: no request outlives its attempt
            await expect.poll(active, { timeout: 2_500 }).toBe(0);
        } finally { await single.close(); }
    });

    // Headers and body must both finish before a cancelled exchange releases its slot.
    it.each([
        ["the deadline before headers", () => ({ maxElapsedTime: 30 }), "/slow?ms=400"],
        ["the caller's abort before headers", () => ({ signal: AbortSignal.timeout(30) }), "/slow?ms=400"],
        ["the deadline before a slow body's headers", () => ({ maxElapsedTime: 30 }), "/slow-body?headersMs=100"],
        ["the deadline during the body", () => ({ maxElapsedTime: 80 }), "/slow-body"],
        ["the caller's abort during the body", () => ({ signal: AbortSignal.timeout(80) }), "/slow-body"],
        ["the deadline during a binary read", () => ({ maxElapsedTime: 80, binary: true }), "/slow-body"],
    ] as const)("settles at %s at once, and close() waits for the exchange to end", async (_cause, options, path) => {
        const single = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, transport: transport() });
        const started = performance.now();
        try {
            await expect(single.request(path, options())).rejects.toBeDefined();
            expect(performance.now() - started).toBeLessThan(200);
            await single.close();
            await expect.poll(active, { timeout: 100 }).toBe(0);
        } finally {
            await single.close();
            await expect.poll(active, { timeout: 1_000 }).toBe(0);
        }
    });

    it.each(["/slow?ms=400", "/slow-body"])("keeps the concurrency limit across cancelled exchanges on %s", async path => {
        const single = new CallPool({ baseUrl, retry: { maxAttempts: 1 }, transport: transport() });
        try {
            for (let i = 0; i < 3; i++) {
                await expect(single.request(path, { maxElapsedTime: 80 })).rejects.toBeInstanceOf(CallPoolTimeoutError);
                expect(active()).toBeLessThanOrEqual(1);
            }
        } finally {
            await single.close();
            await expect.poll(active, { timeout: 1_000 }).toBe(0);
        }
        await expect.poll(active, { timeout: 100 }).toBe(0);
    });

    it("stops at the caller's abort with its reason", async () => {
        const controller = new AbortController();
        const reason = new Error("stop");
        const pending = pool.request("/slow", { signal: controller.signal });
        setTimeout(() => controller.abort(reason), 20);
        await expect(pending).rejects.toBe(reason);
    });

    it("rejects a 404 as a non-retryable CallPoolError", async () => {
        const error = await pool.request("/missing").catch(err => err);
        expect(error).toBeInstanceOf(CallPoolError);
        expect(error).toMatchObject({ statusCode: 404, retryable: false });
    });
});
