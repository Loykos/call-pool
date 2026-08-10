import { describe, it, expect } from "vitest";
import { CallPool, CallPoolError } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Error Handling", () => {
    describe("429 Rate Limit Logic", () => {
        it("should respect the Retry-After header and eventually succeed", async () => {
            const mockServer = new MockServer();
            // NOTE: the mock server evaluates headers() BEFORE statusCode(), so
            // both callbacks must key off getRequestCount(), not a shared counter
            // mutated inside statusCode().
            const baseUrl = await mockServer.start({
                statusCode: () => (mockServer.getRequestCount() === 1 ? 429 : 200),
                headers: () => (mockServer.getRequestCount() === 1 ? { "Retry-After": "2" } : ({} as Record<string, string>)),
            });

            const pool = new CallPool({
                baseUrl,
                retry: { delay: 500 }, // backoff fallback, unused when Retry-After is present
            });

            try {
                const start = Date.now();
                await pool.request("/test-429");
                const duration = Date.now() - start;

                // The Retry-After wait (2s) is honored exactly - no backoff is
                // stacked on top. The upper bound proves the header was used:
                // the 5s no-header default would push the total past 5s.
                expect(duration).toBeGreaterThanOrEqual(2000);
                expect(duration).toBeLessThan(4500);
                expect(mockServer.getRequestCount()).toBe(2);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 10000);

        it("should cap the Retry-After wait at retry.maxRetryAfter", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: () => (mockServer.getRequestCount() === 1 ? 429 : 200),
                headers: () => (mockServer.getRequestCount() === 1 ? { "Retry-After": "30" } : ({} as Record<string, string>)),
            });

            const pool = new CallPool({
                baseUrl,
                retry: { delay: 50, maxRetryAfter: 400 },
            });

            try {
                const start = Date.now();
                await pool.request("/test-429-capped");
                const duration = Date.now() - start;

                // 30s advertised by the server, but the wait is capped at 400ms
                expect(duration).toBeGreaterThanOrEqual(400);
                expect(duration).toBeLessThan(3000);
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

                // The class has a default of 5s for 429 without header
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
                // Must have tried exactly once
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

    describe("Typed Errors", () => {
        it("should expose statusCode, body and headers on CallPoolError", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: 404,
                body: { code: "USR_ERR", message: "User not found" },
            });
            const pool = new CallPool({ baseUrl });

            try {
                const err = await pool.request("/404").catch(e => e);
                expect(err).toBeInstanceOf(CallPoolError);
                expect(err.statusCode).toBe(404);
                expect(err.body).toContain("USR_ERR");
                expect(err.retryable).toBe(false);
                expect(err.headers).toBeDefined();
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should redact Set-Cookie from CallPoolError headers", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: 400,
                headers: { "Set-Cookie": "session=secret", "Content-Type": "text/plain" },
                body: "nope",
            });
            const pool = new CallPool({ baseUrl });

            try {
                const err = await pool.request("/redact").catch(e => e);
                expect(err).toBeInstanceOf(CallPoolError);
                expect(err.headers["set-cookie"]).toBe("[redacted]");
                expect(JSON.stringify(err)).not.toContain("session=secret");
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Abort Signal", () => {
        it("should reject immediately on an already-aborted signal without hitting the server", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({ baseUrl, retry: { maxAttempts: 3, delay: 10 } });

            try {
                const controller = new AbortController();
                controller.abort();

                await expect(pool.request("/never", { signal: controller.signal })).rejects.toThrow();
                expect(mockServer.getRequestCount()).toBe(0);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should not retry a request aborted mid-flight", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ latency: 1000 });
            const pool = new CallPool({ baseUrl, retry: { maxAttempts: 3, delay: 10 } });

            try {
                const controller = new AbortController();
                const promise = pool.request("/slow", { signal: controller.signal });

                await new Promise(r => setTimeout(r, 150));
                controller.abort();

                await expect(promise).rejects.toThrow();

                // Give a (wrong) retry a chance to fire before asserting
                await new Promise(r => setTimeout(r, 300));
                expect(mockServer.getRequestCount()).toBe(1);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 10000);
    });

    describe("408 Request Timeout (Retryable)", () => {
        it("should retry on 408 and eventually succeed", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: () => (mockServer.getRequestCount() === 1 ? 408 : 200),
            });
            const pool = new CallPool({ baseUrl, retry: { maxAttempts: 3, delay: 10 } });

            try {
                const result = await pool.request("/flaky-408");
                expect(result).toBeDefined();
                expect(mockServer.getRequestCount()).toBe(2);
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
                retry: { maxAttempts: 3, delay: 1000 },
            });

            try {
                const start = Date.now();
                await expect(pool.request("/500")).rejects.toThrow("500");
                const duration = Date.now() - start;

                // 3 total attempts: initial attempt + 2 retries. Delay: 1s, then 2s.
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
                latency: () => (++attempt === 1 ? 3000 : 0), // First attempt very slow
            });

            const pool = new CallPool({
                baseUrl,
                network: { timeout: 1000 }, // Timeout at 1s
                retry: { maxAttempts: 2, delay: 500 },
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
            // Closed port
            const pool = new CallPool({
                baseUrl: "http://127.0.0.1:59999",
                retry: { maxAttempts: 2, delay: 100 },
            });

            try {
                await expect(pool.request("/refused")).rejects.toThrow();
            } finally {
                await pool.close();
            }
        });
    });
});
