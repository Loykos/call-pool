import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Error Handling", () => {
    describe("429 Rate Limit Logic", () => {
        it("should respect the Retry-After header and eventually succeed", async () => {
            const mockServer = new MockServer();
            let attempt = 0;
            const baseUrl = await mockServer.start({
                statusCode: () => {
                    attempt++;
                    return attempt === 1 ? 429 : 200;
                },
                headers: () => (attempt === 1 ? { "Retry-After": "2" } : ({} as Record<string, string>)),
            });

            const pool = new CallPool({
                baseUrl,
                retry: { delay: 500 }, // p-retry aggiungerà questo al forceWait
            });

            try {
                const start = Date.now();
                await pool.request("/test-429");
                const duration = Date.now() - start;

                // Spiegazione: 2s (Retry-After) + ~0.5s (p-retry delay)
                expect(duration).toBeGreaterThanOrEqual(2000);
                expect(mockServer.getRequestCount()).toBe(2);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 10000);

        it("should use default 5s wait if Retry-After header is missing", async () => {
            const mockServer = new MockServer();
            let attempt = 0;
            const baseUrl = await mockServer.start({
                statusCode: () => (++attempt === 1 ? 429 : 200),
            });

            const pool = new CallPool({ baseUrl });

            try {
                const start = Date.now();
                await pool.request("/test-429-no-header");
                const duration = Date.now() - start;

                // La classe ha un default di 5s per i 429 senza header
                expect(duration).toBeGreaterThanOrEqual(5000);
                expect(mockServer.getRequestCount()).toBe(2);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 15000);
    });

    describe("4xx Client Errors (Non-retryable)", () => {
        it("should throw AbortError on 400/404 and NOT retry", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: 400,
                body: "Invalid Payload",
            });
            const pool = new CallPool({ baseUrl, retry: { maxAttempts: 5 } });

            try {
                await expect(pool.request("/400")).rejects.toThrow(/Client Error 400: Invalid Payload/);
                // Deve aver provato esattamente una volta
                expect(mockServer.getRequestCount()).toBe(1);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should parse and include JSON error bodies in the exception", async () => {
            const mockServer = new MockServer();
            const errorObj = { code: "USR_ERR", message: "User not found" };
            const baseUrl = await mockServer.start({
                statusCode: 404,
                body: errorObj,
            });
            const pool = new CallPool({ baseUrl });

            try {
                await expect(pool.request("/404")).rejects.toThrow(/User not found/);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("5xx Server Errors (Retryable)", () => {
        it("should exhaust all retries on persistent 500", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ statusCode: 500 });

            const pool = new CallPool({
                baseUrl,
                retry: { maxAttempts: 2, delay: 1000 },
            });

            try {
                const start = Date.now();
                await expect(pool.request("/500")).rejects.toThrow("Server Error: 500");
                const duration = Date.now() - start;

                // 1 tentativo + 2 retry. Delay: 1s, poi 2s (factor 2). Totale attesa ~3s.
                expect(duration).toBeGreaterThanOrEqual(3000);
                expect(mockServer.getRequestCount()).toBe(3);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 15000);
    });

    describe("Network & Timeout Errors", () => {
        it("should retry when server is too slow (Timeout)", async () => {
            const mockServer = new MockServer();
            let attempt = 0;
            const baseUrl = await mockServer.start({
                latency: () => (++attempt === 1 ? 3000 : 0), // Primo tentativo lentissimo
            });

            const pool = new CallPool({
                baseUrl,
                network: { timeout: 1000 }, // Timeout a 1s
                retry: { maxAttempts: 1, delay: 500 },
            });

            try {
                const result = await pool.request("/timeout");
                expect(result).toBeDefined();
                expect(mockServer.getRequestCount()).toBe(2);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 10000);

        it("should retry on connection refused", async () => {
            // Porta chiusa
            const pool = new CallPool({
                baseUrl: "http://127.0.0.1:59999",
                retry: { maxAttempts: 1, delay: 100 },
            });

            try {
                await expect(pool.request("/refused")).rejects.toThrow();
            } finally {
                await pool.close();
            }
        });
    });
});
