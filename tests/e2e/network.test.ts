import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConnector, Client, type Pool } from "undici";
import { CallPool, CallPoolTimeoutError } from "../../src/index";

let directory: string;
let cert: Buffer;
let key: Buffer;
beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "call-pool-e2e-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    cert = readFileSync(join(directory, "cert.pem"));
    key = readFileSync(join(directory, "key.pem"));
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

async function fixture(handler: RequestListener = (_req, res) => res.end("ok"), secureProxy = false) {
    const sockets = new Set<Socket>();
    const target = createHttpsServer({ cert, key }, handler);
    const proxy = secureProxy ? createHttpsServer({ cert, key }) : createHttpServer();
    const tunnels: { target: string | undefined; headers: Record<string, unknown> }[] = [];
    let connections = 0;
    target.on("secureConnection", () => connections++);
    for (const server of [target, proxy]) server.on("connection", socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (req, client, head) => {
        tunnels.push({ target: req.url, headers: req.headers });
        // Dial only this fixture's target; never an address supplied by a peer.
        const upstream = connect((target.address() as AddressInfo).port, "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        sockets.add(upstream);
        upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
        client.on("close", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
    });
    for (const server of [target, proxy]) {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    }
    return {
        target,
        baseUrl: `https://localhost:${(target.address() as AddressInfo).port}`,
        uri: `${secureProxy ? "https" : "http"}://localhost:${(proxy.address() as AddressInfo).port}`,
        tunnels,
        connections: () => connections,
        async stop() {
            for (const socket of sockets) socket.destroy();
            await Promise.all([target, proxy].map(server => new Promise<void>((resolve, reject) => (server as HttpServer).close(error => error ? reject(error) : resolve()))));
        },
    };
}

describe("HTTPS and CONNECT transport end to end", () => {
    it.each(["reuse", "pipelining=0", "request reset"])("%s controls actual tunnel reuse", async mode => {
        const seen: Record<string, unknown>[] = [];
        const f = await fixture((req, res) => { seen.push(req.headers); res.end("ok"); });
        const pool = new CallPool({ baseUrl: f.baseUrl, defaultHeaders: { "x-target-default": "target" }, network: {
            uri: f.uri, requestTls: { ca: cert }, token: "Basic fixture-token", headers: { "x-proxy-only": "proxy" },
            ...(mode === "pipelining=0" ? { pipelining: 0 } : {}),
        } });
        try {
            for (let i = 0; i < 5; i++) await expect(pool.request(`/r${i}`, { reset: mode === "request reset" })).resolves.toBe("ok");
            expect(f.tunnels).toHaveLength(mode === "reuse" ? 1 : 5);
            expect(f.connections()).toBe(mode === "reuse" ? 1 : 5);
            for (const tunnel of f.tunnels) {
                expect(tunnel.target).toBe(new URL(f.baseUrl).host);
                expect(tunnel.headers["proxy-authorization"]).toBe("Basic fixture-token");
                expect(tunnel.headers["x-proxy-only"]).toBe("proxy");
                expect(tunnel.headers["x-target-default"]).toBeUndefined();
            }
            expect(seen).toHaveLength(5);
            for (const headers of seen) {
                expect(headers["x-target-default"]).toBe("target");
                expect(headers["x-proxy-only"]).toBeUndefined();
                expect(headers["proxy-authorization"]).toBeUndefined();
            }
        } finally { await pool.close(); await f.stop(); }
    });

    it.each([0, 1])("forwards pipelining=%i and TLS to a direct Pool", async pipelining => {
        const f = await fixture();
        const pool = new CallPool({ baseUrl: f.baseUrl, network: { connect: { ca: cert }, pipelining } });
        try {
            for (let i = 0; i < 3; i++) await pool.request("/");
            expect(f.connections()).toBe(pipelining === 0 ? 3 : 1);
            expect(f.tunnels).toHaveLength(0);
        } finally { await pool.close(); await f.stop(); }
    });

    it.each([false, true])("native connections overrides transport capacity independently of scheduler (proxy=%s)", async proxied => {
        let running = 0;
        let peak = 0;
        const f = await fixture((_req, res) => {
            peak = Math.max(peak, ++running);
            setTimeout(() => { running--; res.end("ok"); }, 25);
        });
        const pool = new CallPool({ baseUrl: f.baseUrl, concurrency: { limit: 4 }, network: {
            ...(proxied ? { uri: f.uri, requestTls: { ca: cert } } : { connect: { ca: cert } }), connections: 1,
        } });
        try {
            await Promise.all(Array.from({ length: 8 }, () => pool.request("/")));
            expect(pool.getCurrentConcurrency()).toBe(4);
            expect(peak).toBe(1);
            expect(f.connections()).toBe(1);
        } finally { await pool.close(); await f.stop(); }
    });

    it("accepts native connector functions and Pool factories unchanged", async () => {
        const f = await fixture();
        const connector = buildConnector({ ca: cert });
        let factoryCalls = 0;
        let connectorCalls = 0;
        const pool = new CallPool({ baseUrl: f.baseUrl, network: {
            connect: (options, callback) => { connectorCalls++; connector(options, callback); },
            factory: (origin, options) => { factoryCalls++; return new Client(origin, options); },
        } satisfies Pool.Options });
        try {
            await expect(pool.request("/")).resolves.toBe("ok");
            expect(factoryCalls).toBe(1);
            expect(connectorCalls).toBe(1);
        } finally { await pool.close(); await f.stop(); }
    });

    it("applies proxyTls and requestTls separately on an HTTPS proxy", async () => {
        const f = await fixture(undefined, true);
        const proxyUntrusted = new CallPool({ baseUrl: f.baseUrl, retry: { maxAttempts: 1 }, network: { uri: f.uri, requestTls: { ca: cert } } });
        const targetUntrusted = new CallPool({ baseUrl: f.baseUrl, retry: { maxAttempts: 1 }, network: { uri: f.uri, proxyTls: { ca: cert } } });
        const trusted = new CallPool({ baseUrl: f.baseUrl, network: { uri: f.uri, proxyTls: { ca: cert }, requestTls: { ca: cert } } });
        try {
            await expect(proxyUntrusted.request("/")).rejects.toThrow();
            await expect(targetUntrusted.request("/")).rejects.toThrow();
            await expect(trusted.request("/")).resolves.toBe("ok");
        } finally { await Promise.all([proxyUntrusted.close(), targetUntrusted.close(), trusted.close()]); await f.stop(); }
    });

    it.each([["headers", false], ["body", false], ["headers", true], ["body", true]] as const)("honors native %s timeout and per-request override (proxy=%s)", async (phase, proxied) => {
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const f = await fixture((_req, res) => {
            if (phase === "body") res.write("start");
            const timer = setTimeout(() => { timers.delete(timer); res.end("end"); }, 1800);
            timers.add(timer);
            res.on("close", () => { clearTimeout(timer); timers.delete(timer); });
        });
        const timeoutKey = phase === "body" ? "bodyTimeout" : "headersTimeout";
        const pool = new CallPool({ baseUrl: f.baseUrl, retry: { maxAttempts: 1 }, network: { ...(proxied ? { uri: f.uri, requestTls: { ca: cert } } : { connect: { ca: cert } }), [timeoutKey]: 100 } });
        try {
            await expect(pool.request("/default")).rejects.toMatchObject({ code: phase === "body" ? "UND_ERR_BODY_TIMEOUT" : "UND_ERR_HEADERS_TIMEOUT" });
            await expect(pool.request("/override", { [timeoutKey]: 3000 })).resolves.toBe(phase === "body" ? "startend" : "end");
            // Zero keeps Undici's native meaning: disable this timeout.
            await expect(pool.request("/disabled", { [timeoutKey]: 0 })).resolves.toBe(phase === "body" ? "startend" : "end");
        } finally {
            await pool.close();
            for (const timer of timers) clearTimeout(timer);
            await f.stop();
        }
    });
});

describe("429 recovery through a real TLS tunnel", () => {
    it("bounds a 150-request banned backlog, then accepts work after the pause", async () => {
        let banned = true;
        let requests = 0;
        const f = await fixture((_req, res) => { requests++; res.writeHead(banned ? 429 : 200); res.end(banned ? "banned" : "ok"); });
        const pool = new CallPool({ baseUrl: f.baseUrl, maxElapsedTime: 400, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 800 } }, retry: { delay: 800 }, network: { uri: f.uri, requestTls: { ca: cert } } });
        try {
            const start = performance.now();
            const results = await Promise.allSettled(Array.from({ length: 150 }, (_, i) => pool.request(`/row-${i}`)));
            expect(results.every(result => result.status === "rejected" && result.reason instanceof CallPoolTimeoutError)).toBe(true);
            expect(requests).toBe(1);
            expect(performance.now() - start).toBeLessThan(650);
            expect(pool.getStats()).toMatchObject({ running: 0, queued: 0 });
            await expect(pool.request("/still-paused")).rejects.toBeInstanceOf(CallPoolTimeoutError);
            banned = false;
            await new Promise(resolve => setTimeout(resolve, 850));
            await expect(pool.request("/recovered")).resolves.toBe("ok");
            expect(requests).toBe(2);
        } finally { await pool.close(); await f.stop(); }
    });

    it("keeps queued work without a deadline and resumes after the refused job exhausts its attempts", async () => {
        const arrivals: { path: string; at: number }[] = [];
        const f = await fixture((req, res) => {
            arrivals.push({ path: req.url!, at: performance.now() });
            res.writeHead(req.url === "/banned" ? 429 : 200).end("result");
        });
        const pool = new CallPool({ baseUrl: f.baseUrl, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 120 } }, retry: { delay: 50, factor: 2, maxDelay: 120 }, network: { uri: f.uri, requestTls: { ca: cert }, pipelining: 0 } });
        try {
            const failed = pool.request("/banned").catch(error => error);
            const queued = pool.request("/queued");
            expect(await failed).toMatchObject({ statusCode: 429 });
            expect(pool.getStats().pausedFor).toBeGreaterThan(0);
            await expect(queued).resolves.toBe("result");
            expect(arrivals.map(item => item.path)).toEqual(["/banned", "/banned", "/banned", "/queued"]);
            const gaps = arrivals.slice(1).map((item, i) => item.at - arrivals[i].at);
            expect(gaps[0]).toBeGreaterThanOrEqual(49);
            expect(gaps[1]).toBeGreaterThanOrEqual(99);
            expect(gaps[2]).toBeGreaterThanOrEqual(119);
            expect(f.tunnels).toHaveLength(4);
        } finally { await pool.close(); await f.stop(); }
    });
});

describe("circuit breaker over real HTTPS/CONNECT", () => {
    it("opens on three 403s and serializes two successful probes before releasing the queue", async () => {
        const arrivals: string[] = [];
        const held: import("node:http").ServerResponse[] = [];
        let recoveryRequests = 0;
        const f = await fixture((req, res) => {
            arrivals.push(req.url!);
            if (req.url!.startsWith("/blocked")) res.writeHead(403).end("blocked");
            else if (++recoveryRequests <= 2) held.push(res);
            else res.end("ok");
        });
        const pool = new CallPool({ baseUrl: f.baseUrl, concurrency: { limit: 4 }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, halfOpen: { after: 100 } }, network: { uri: f.uri, requestTls: { ca: cert } } });
        try {
            const refused = await Promise.allSettled([0, 1, 2].map(i => pool.request(`/blocked-${i}`)));
            expect(refused.every(result => result.status === "rejected")).toBe(true);
            expect(pool.getStats().circuitBreaker).toBe("open");
            const pending = Array.from({ length: 8 }, (_, i) => pool.request(`/recovery-${i}`));
            await expect.poll(() => held.length).toBe(1);
            expect(arrivals).toHaveLength(4);
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            held.shift()!.end("ok");
            await expect.poll(() => held.length).toBe(1);
            expect(arrivals).toHaveLength(5);
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            held.shift()!.end("ok");
            expect(await Promise.all(pending)).toEqual(Array(8).fill("ok"));
            expect(pool.getStats()).toMatchObject({ circuitBreaker: "closed", queued: 0, running: 0 });
            expect(arrivals).toHaveLength(11);
        } finally { held.splice(0).forEach(res => res.end("ok")); await pool.close(); await f.stop(); }
    });

    it("reopens after a late failed parallel probe even when another probe already succeeded", async () => {
        let arrivals = 0;
        const held: import("node:http").ServerResponse[] = [];
        const f = await fixture((_req, res) => {
            arrivals++;
            if (arrivals === 1) res.writeHead(403).end("blocked");
            else if (arrivals <= 3) held.push(res);
            else res.end("ok");
        });
        const pool = new CallPool({ baseUrl: f.baseUrl, concurrency: { limit: 4 }, retry: { maxAttempts: 1 }, circuitBreaker: { enabled: true, failureThreshold: 1, halfOpen: { after: 100, maxConcurrent: 2, successThreshold: 1 } }, network: { uri: f.uri, requestTls: { ca: cert }, pipelining: 0 } });
        try {
            await expect(pool.request("/trip")).rejects.toMatchObject({ statusCode: 403 });
            const pending = Array.from({ length: 4 }, (_, i) => pool.request(`/probe-${i}`).catch(error => error));
            await expect.poll(() => held.length).toBe(2);
            held.splice(held.findIndex(res => res.req.url === "/probe-0"), 1)[0].end("ok");
            await expect(pending[0]).resolves.toBe("ok");
            expect(pool.getStats().circuitBreaker).toBe("half-open");
            expect(arrivals).toBe(3);
            held.shift()!.writeHead(403).end("still blocked");
            await expect(pending[1]).resolves.toMatchObject({ statusCode: 403 });
            expect(pool.getStats().circuitBreaker).toBe("open");
            expect(arrivals).toBe(3);
            await Promise.all(pending);
            expect(pool.getStats().circuitBreaker).toBe("closed");
            expect(arrivals).toBe(5);
            expect(f.tunnels).toHaveLength(5);
        } finally { held.splice(0).forEach(res => res.end("ok")); await pool.close(); await f.stop(); }
    });
});
