import { describe, it, expect, vi } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Retry Suite", () => {
    describe("Retry on 5xx errors", () => {
        it("should retry on 500 error and eventually succeed", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: () => (mockServer.getRequestCount() <= 2 ? 500 : 200),
            });

            const pool = new CallPool({
                baseUrl,
                retry: { maxAttempts: 3, delay: 10 },
            });

            try {
                const result = await pool.request("/test-success");
                expect(result).toBeDefined();
                expect(mockServer.getRequestCount()).toBe(3);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should respect maxAttempts limit on persistent 500", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ statusCode: 500 });

            const pool = new CallPool({
                baseUrl,
                retry: { maxAttempts: 2, delay: 10 },
            });

            try {
                await expect(pool.request("/always-500")).rejects.toThrow("Server Error: 500");
                // 1 iniziale + 2 retry = 3 tentativi
                expect(mockServer.getRequestCount()).toBe(3);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("No retry on 4xx errors", () => {
        it("should not retry on 400 Bad Request", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ statusCode: 400 });

            const pool = new CallPool({ baseUrl, retry: { maxAttempts: 3 } });

            try {
                await expect(pool.request("/bad-request")).rejects.toThrow("Client Error 400");
                expect(mockServer.getRequestCount()).toBe(1);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should not retry on 404 Not Found", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ statusCode: 404 });

            const pool = new CallPool({ baseUrl, retry: { maxAttempts: 3 } });

            try {
                await expect(pool.request("/not-found")).rejects.toThrow("Client Error 404");
                expect(mockServer.getRequestCount()).toBe(1);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Exponential backoff & Timing", () => {
        it("should use exponential backoff logic", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({ statusCode: 500 });

            const pool = new CallPool({
                baseUrl,
                retry: { maxAttempts: 2, delay: 1000, factor: 2 },
            });

            try {
                const reqPromise = pool.request("/backoff");

                await expect(reqPromise).rejects.toThrow();
                expect(mockServer.getRequestCount()).toBe(3);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should respect Retry-After header on 429", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                statusCode: () => (mockServer.getRequestCount() === 1 ? 429 : 200),
                headers: () => (mockServer.getRequestCount() === 1 ? { "Retry-After": "5" } : ({} as Record<string, string>)),
            });

            const pool = new CallPool({
                baseUrl,
                retry: { maxAttempts: 1, delay: 500 },
            });

            try {
                const reqPromise = pool.request("/rate-limit");

                const result = await reqPromise;
                expect(result).toBeDefined();
                expect(mockServer.getRequestCount()).toBe(2);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Network Errors", () => {
        it("should retry on connection refused", async () => {
            // Porta non esistente per forzare errore di rete
            const pool = new CallPool({
                baseUrl: "http://127.0.0.1:59999",
                retry: { maxAttempts: 1, delay: 10 },
            });

            try {
                await expect(pool.request("/network-error")).rejects.toThrow();
            } finally {
                await pool.close();
            }
        });
    });
});
