import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "https";
import { AddressInfo } from "net";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CallPool } from "../../src/index";

/**
 * Certificates are generated at run time so the suite never ships an expiring
 * fixture. Skipped when openssl is unavailable.
 */
const hasOpenssl = (() => {
    try {
        execFileSync("openssl", ["version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();

describe.skipIf(!hasOpenssl)("TLS with a private CA", () => {
    let dir: string;
    let ca: string;
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "call-pool-tls-"));
        const keyPath = join(dir, "key.pem");
        const certPath = join(dir, "cert.pem");

        execFileSync("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", keyPath, "-out", certPath,
            "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost",
        ], { stdio: "ignore" });

        ca = readFileSync(certPath, "utf8");
        server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });

        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    });

    const poolFor = (tls?: any) => new CallPool({ baseUrl, retry: { maxAttempts: 1 }, network: { timeout: 5000, tls } });

    it("should fail without the CA", async () => {
        const pool = poolFor();
        try {
            await expect(pool.request("/")).rejects.toThrow();
        } finally {
            await pool.close();
        }
    });

    it("should succeed when the CA is trusted", async () => {
        const pool = poolFor({ ca });
        try {
            const res = await pool.request<{ ok: boolean }>("/");
            expect(res).toEqual({ ok: true });
        } finally {
            await pool.close();
        }
    });

    it("should accept the CA as a Buffer and as an array", async () => {
        const pools = [poolFor({ ca: Buffer.from(ca) }), poolFor({ ca: [ca] })];
        try {
            const results = await Promise.all(pools.map(p => p.request<{ ok: boolean }>("/")));
            results.forEach(res => expect(res).toEqual({ ok: true }));
        } finally {
            await Promise.all(pools.map(p => p.close()));
        }
    });

    it("should skip verification when rejectUnauthorized is false", async () => {
        const pool = poolFor({ rejectUnauthorized: false });
        try {
            const res = await pool.request<{ ok: boolean }>("/");
            expect(res).toEqual({ ok: true });
        } finally {
            await pool.close();
        }
    });

    it("should confine the trusted CA to the pool that declares it", async () => {
        // The core guarantee: a pool holding a private CA must not make that CA
        // trusted for anything else in the process.
        const trusting = poolFor({ ca });
        const plain = poolFor();
        try {
            await expect(trusting.request("/")).resolves.toBeDefined();
            await expect(plain.request("/")).rejects.toThrow();
            // ...and the order does not matter either
            await expect(plain.request("/")).rejects.toThrow();
            await expect(trusting.request("/")).resolves.toBeDefined();
        } finally {
            await Promise.all([trusting.close(), plain.close()]);
        }
    });
});
