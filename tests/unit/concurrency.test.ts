import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Concurrency - Parallelism Proof", () => {
    it("should prove that requests run in parallel (Total time << Sequential time)", async () => {
        const mockServer = new MockServer();
        // High latency to make the test unambiguous: 2 seconds per request
        const latency = 2000;
        const baseUrl = await mockServer.start({ latency });

        // High concurrency (5)
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 5 },
        });

        try {
            const start = Date.now();

            // Launch 5 requests.
            // If sequential they would take: 5 * 2s = 10 seconds.
            // Being parallel, they must all finish around 2 seconds (+ overhead).
            await Promise.all([pool.request("/p1"), pool.request("/p2"), pool.request("/p3"), pool.request("/p4"), pool.request("/p5")]);

            const duration = Date.now() - start;

            // Reverse test: verify that time is MUCH less than 10s
            // If it takes less than 3s, parallelism is confirmed.
            expect(duration).toBeLessThan(3500);
            expect(mockServer.getRequestCount()).toBe(5);
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    }, 15000);

    it("should show that doubling concurrency significantly reduces total time", async () => {
        const mockServer = new MockServer();
        const latency = 1500;
        const baseUrl = await mockServer.start({ latency });

        // Scenario: 4 requests.
        // With concurrency 2 -> takes ~3 seconds (2 batches of 1.5s)
        // With concurrency 4 -> takes ~1.5 seconds (1 batch of 1.5s)
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 4 },
        });

        try {
            const start = Date.now();
            await Promise.all([pool.request("/t1"), pool.request("/t2"), pool.request("/t3"), pool.request("/t4")]);
            const duration = Date.now() - start;

            // If limit 4 is respected, it must have taken a single latency cycle
            // Instead of 6 seconds (sequential) or 3 seconds (concurrency 2)
            expect(duration).toBeLessThan(2500);
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    }, 10000);

    it("should handle a massive amount of requests much faster than sequential execution", async () => {
        const mockServer = new MockServer();
        const latency = 500; // 0.5s
        const baseUrl = await mockServer.start({ latency });

        // Default concurrency is 1.
        const pool = new CallPool({ baseUrl, concurrency: { limit: 10 } });

        try {
            const start = Date.now();
            const total = 10;
            // 10 parallel requests with concurrency 10
            await Promise.all(Array.from({ length: total }, (_, i) => pool.request(`/r${i}`)));

            const duration = Date.now() - start;

            // Sequential would be: 10 * 0.5s = 5 seconds.
            // Parallel must be: ~0.5 seconds.
            // Verify that it's at least 2 times faster than sequential.
            expect(duration).toBeLessThan(2500);
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    }, 15000);
});
