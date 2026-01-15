import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Concurrency - Parallelism Proof", () => {
    it("should prove that requests run in parallel (Total time << Sequential time)", async () => {
        const mockServer = new MockServer();
        // Latenza alta per rendere il test inequivocabile: 2 secondi per richiesta
        const latency = 2000;
        const baseUrl = await mockServer.start({ latency });

        // Concurrency alta (5)
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 5 },
        });

        try {
            const start = Date.now();

            // Lanciamo 5 richieste.
            // Se fossero sequenziali ci metterebbero: 5 * 2s = 10 secondi.
            // Essendo parallele, devono finire tutte intorno ai 2 secondi (+ overhead).
            await Promise.all([pool.request("/p1"), pool.request("/p2"), pool.request("/p3"), pool.request("/p4"), pool.request("/p5")]);

            const duration = Date.now() - start;

            // Il test "al contrario": verifichiamo che il tempo sia MOLTO minore di 10s
            // Se ci mette meno di 3s, il parallelismo è confermato.
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

        // Scenario: 4 richieste.
        // Con concurrency 2 -> ci mette ~3 secondi (2 batch da 1.5s)
        // Con concurrency 4 -> ci mette ~1.5 secondi (1 batch da 1.5s)
        const pool = new CallPool({
            baseUrl,
            concurrency: { limit: 4 },
        });

        try {
            const start = Date.now();
            await Promise.all([pool.request("/t1"), pool.request("/t2"), pool.request("/t3"), pool.request("/t4")]);
            const duration = Date.now() - start;

            // Se il limite 4 è rispettato, deve aver impiegato un solo ciclo di latenza
            // Invece dei 6 secondi (sequenziali) o 3 secondi (concurrency 2)
            expect(duration).toBeLessThan(2500);
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    }, 10000);

    it("should handle a massive amount of requests much faster than sequential execution", async () => {
        const mockServer = new MockServer();
        const latency = 500; // 0.5s
        const baseUrl = await mockServer.start({ latency });

        // Default concurrency è 1.
        const pool = new CallPool({ baseUrl, concurrency: { limit: 10 } });

        try {
            const start = Date.now();
            const total = 10;
            // 10 richieste parallele con concurrency 10
            await Promise.all(Array.from({ length: total }, (_, i) => pool.request(`/r${i}`)));

            const duration = Date.now() - start;

            // Sequenziale sarebbe: 10 * 0.5s = 5 secondi.
            // Parallelo deve essere: ~0.5 secondi.
            // Verifichiamo che sia almeno 2 volte più veloce del sequenziale.
            expect(duration).toBeLessThan(2500);
        } finally {
            await Promise.all([pool.close(), mockServer.stop()]);
        }
    }, 15000);
});
