import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import { connect, AddressInfo } from "net";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

interface SeenTunnel {
    target: string;
    auth?: string;
}

/**
 * Minimal HTTP CONNECT proxy: authenticates (optionally), dials the requested
 * target and pipes the two sockets. Mirrors what any forward proxy
 * (iproyal-style or an in-house gateway) does, without touching the bytes.
 */
class ConnectProxy {
    private server: Server | null = null;
    readonly tunnels: SeenTunnel[] = [];

    async start(requiredAuth?: string): Promise<string> {
        this.server = createServer((_req, res) => {
            res.writeHead(405).end();
        });
        this.server.on("connect", (req, clientSocket, head) => {
            const auth = req.headers["proxy-authorization"];
            this.tunnels.push({ target: req.url ?? "", auth: Array.isArray(auth) ? auth[0] : auth });

            if (requiredAuth && auth !== requiredAuth) {
                clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
                clientSocket.destroy();
                return;
            }

            const [host, port] = (req.url ?? "").split(":");
            const upstream = connect(Number(port), host, () => {
                clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length > 0) upstream.write(head);
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            });
            upstream.on("error", () => clientSocket.destroy());
            clientSocket.on("error", () => upstream.destroy());
        });

        await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>(resolve => this.server!.close(() => resolve()));
        this.server = null;
    }
}

describe("Proxy support", () => {
    let target: MockServer;
    let baseUrl: string;

    beforeAll(async () => {
        target = new MockServer();
        baseUrl = await target.start({ body: { via: "target" } });
    });

    afterAll(async () => {
        await target.stop();
    });

    it("should tunnel requests through the proxy and keep target semantics", async () => {
        const proxy = new ConnectProxy();
        const proxyUrl = await proxy.start();
        const pool = new CallPool({ baseUrl, network: { proxy: proxyUrl } });

        try {
            const body = await pool.request<{ via: string }>("/tunneled");
            expect(body).toEqual({ via: "target" });

            // The tunnel targets the origin of baseUrl, not the proxy itself
            const targetHostPort = new URL(baseUrl).host;
            expect(proxy.tunnels.length).toBeGreaterThan(0);
            expect(proxy.tunnels[0].target).toBe(targetHostPort);

            // The request itself reached the target untouched
            const requests = target.getRequests();
            expect(requests.at(-1)?.path).toBe("/tunneled");
        } finally {
            await Promise.all([pool.close(), proxy.stop()]);
        }
    });

    it("should send URL-embedded credentials as Proxy-Authorization (Basic)", async () => {
        const expectedAuth = `Basic ${Buffer.from("user:p@ss/word").toString("base64")}`;
        const proxy = new ConnectProxy();
        const proxyUrl = await proxy.start(expectedAuth);
        const { hostname, port } = new URL(proxyUrl);
        const authedUrl = `http://${encodeURIComponent("user")}:${encodeURIComponent("p@ss/word")}@${hostname}:${port}`;
        const pool = new CallPool({ baseUrl, network: { proxy: authedUrl } });

        try {
            const body = await pool.request<{ via: string }>("/authed");
            expect(body).toEqual({ via: "target" });
            expect(proxy.tunnels[0].auth).toBe(expectedAuth);
        } finally {
            await Promise.all([pool.close(), proxy.stop()]);
        }
    });

    it("should surface target HTTP errors unchanged through the tunnel", async () => {
        const errorTarget = new MockServer();
        const errorBaseUrl = await errorTarget.start({ statusCode: 404, body: "not here" });
        const proxy = new ConnectProxy();
        const proxyUrl = await proxy.start();
        const pool = new CallPool({
            baseUrl: errorBaseUrl,
            retry: { maxAttempts: 1 },
            network: { proxy: proxyUrl },
        });

        try {
            await expect(pool.request("/missing")).rejects.toMatchObject({ statusCode: 404 });
        } finally {
            await Promise.all([pool.close(), proxy.stop(), errorTarget.stop()]);
        }
    });
});
