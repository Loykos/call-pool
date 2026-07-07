import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

describe.concurrent("Priority Queue Enforcement", () => {
    it("should reorder requests in the queue (Lower number = Higher Priority)", async () => {
        const mockServer = new MockServer();
        // High latency: the server "holds" the request for 2 seconds
        // During this time, CallPool cannot send anything else (concurrency: 1)
        const baseUrl = await mockServer.start({ latency: 2000 });

        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 1 },
        });

        try {
            // 1. This request starts immediately and "occupies" the pool for 2 seconds
            const blocker = pool.request("/blocker", { priority: 5 });

            // Wait a moment to ensure the blocker has reached the server
            await wait(200);

            // 2. Send three requests while the blocker is still active.
            // These MUST end up in queue and Bottleneck must reorder them.
            // We intentionally insert the low priority one (9) first and then the high one (1)
            const p9 = pool.request("/priority-low-9", { priority: 9 });
            const p1 = pool.request("/priority-high-1", { priority: 1 });
            const p5 = pool.request("/priority-mid-5", { priority: 5 });

            // Wait for everything to finish
            await Promise.all([blocker, p9, p1, p5]);

            // 3. Verify the ARRIVAL order on the server
            const requests = mockServer.getRequests();

            // The blocker is always first (index 0)
            expect(requests[0].path).toBe("/blocker");

            // The second arrival must be priority 1, even if called after 9!
            // If this test passes, it means Bottleneck has reordered the queue.
            expect(requests[1].path).toBe("/priority-high-1");
            expect(requests[2].path).toBe("/priority-mid-5");
            expect(requests[3].path).toBe("/priority-low-9");
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    }, 20000); // Timeout lungo per gestire le latenze simulate

    it("should handle default priority (5) correctly", async () => {
        const mockServer = new MockServer();
        const baseUrl = await mockServer.start({ latency: 1500 });
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 1 },
        });

        try {
            const blocker = pool.request("/blocker");
            await wait(200);

            // In queue: one with priority 6 and one without (default 5)
            const p6 = pool.request("/p6", { priority: 6 });
            const pDefault = pool.request("/default");

            await Promise.all([blocker, p6, pDefault]);

            const reqs = mockServer.getRequests();
            // Default (5) wins over 6
            expect(reqs[1].path).toBe("/default");
            expect(reqs[2].path).toBe("/p6");
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    });

    it("should reject priority outside the supported range", async () => {
        const pool = new CallPool({ baseUrl: "http://localhost" });

        try {
            await expect(pool.request("/invalid-low", { priority: -1 })).rejects.toThrow(/priority/);
            await expect(pool.request("/invalid-high", { priority: 10 })).rejects.toThrow(/priority/);
        } finally {
            await pool.close();
        }
    });

    it("should respect priority with latency even without concurrency limit", async () => {
        const mockServer = new MockServer();
        const baseUrl = await mockServer.start({ latency: 2000 });
        const pool = new CallPool({ baseUrl });

        try {
            const r1 = pool.request("/first", { priority: 5 }); // Starts immediately
            await wait(100);

            const rLow = pool.request("/low", { priority: 8 });
            const rHigh = pool.request("/high", { priority: 2 });

            await Promise.all([r1, rLow, rHigh]);

            const requests = mockServer.getRequests();
            expect(requests[0].path).toBe("/first");
            // At 2000ms, Bottleneck chooses the highest in queue
            expect(requests[1].path).toBe("/high");
            expect(requests[2].path).toBe("/low");
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    });
});
