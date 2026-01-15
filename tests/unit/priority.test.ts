import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

describe.concurrent("Priority Queue Enforcement", () => {
    it("should reorder requests in the queue (Lower number = Higher Priority)", async () => {
        const mockServer = new MockServer();
        // Latenza alta: il server "trattiene" la richiesta per 2 secondi
        // Durante questo tempo, il CallPool non può inviare altro (concurrency: 1)
        const baseUrl = await mockServer.start({ latency: 2000 });

        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 1 },
        });

        try {
            // 1. Questa richiesta parte subito e "occupa" il pool per 2 secondi
            const blocker = pool.request("/blocker", { priority: 5 });

            // Aspettiamo un attimo per essere certi che il blocker sia arrivato al server
            await wait(200);

            // 2. Inviamo tre richieste mentre il blocker è ancora attivo.
            // Queste DEVONO finire in coda e Bottleneck le deve riordinare.
            // Inseriamo volutamente prima quella a priorità bassa (9) e poi quella alta (1)
            const p9 = pool.request("/priority-low-9", { priority: 9 });
            const p1 = pool.request("/priority-high-1", { priority: 1 });
            const p5 = pool.request("/priority-mid-5", { priority: 5 });

            // Aspettiamo che tutto finisca
            await Promise.all([blocker, p9, p1, p5]);

            // 3. Verifichiamo l'ordine di ARRIVO sul server
            const requests = mockServer.getRequests();

            // Il blocker è sempre il primo (indice 0)
            expect(requests[0].path).toBe("/blocker");

            // Il secondo arrivo deve essere la priorità 1, anche se chiamata dopo la 9!
            // Se questo test passa, significa che Bottleneck ha riordinato la coda.
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

            // In coda: una con priorità 6 e una senza (default 5)
            const p6 = pool.request("/p6", { priority: 6 });
            const pDefault = pool.request("/default");

            await Promise.all([blocker, p6, pDefault]);

            const reqs = mockServer.getRequests();
            // Default (5) vince su 6
            expect(reqs[1].path).toBe("/default");
            expect(reqs[2].path).toBe("/p6");
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    });

    it("should respect priority with latency even without concurrency limit", async () => {
        const mockServer = new MockServer();
        const baseUrl = await mockServer.start({ latency: 2000 });
        const pool = new CallPool({ baseUrl });

        try {
            const r1 = pool.request("/first", { priority: 5 }); // Parte subito
            await wait(100);

            const rLow = pool.request("/low", { priority: 8 });
            const rHigh = pool.request("/high", { priority: 2 });

            await Promise.all([r1, rLow, rHigh]);

            const requests = mockServer.getRequests();
            expect(requests[0].path).toBe("/first");
            // Allo scoccare dei 2000ms, Bottleneck sceglie la più alta in coda
            expect(requests[1].path).toBe("/high");
            expect(requests[2].path).toBe("/low");
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    });
});
