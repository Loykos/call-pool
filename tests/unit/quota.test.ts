import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

// Helper per attese esplicite
const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

describe.concurrent("Quota Enforcement & Rate Limiting", () => {
    describe("High-Latency Quota Logic", () => {
        it("should strictly enforce quota over multiple windows", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            /**
             * CONFIGURAZIONE:
             * Max 2 richieste ogni 2000ms (2 secondi).
             * 5 richieste totali:
             * - 1, 2: Partono subito (T=0)
             * - 3, 4: Partono dopo il 1° refresh (T=2000ms)
             * - 5: Parte dopo il 2° refresh (T=4000ms)
             */
            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    quota: { max: 2, window: 2000 },
                },
            });

            try {
                const start = Date.now();
                const totalRequests = 5;

                const promises = Array.from({ length: totalRequests }, () => pool.request("/long-quota"));
                await Promise.all(promises);

                const duration = Date.now() - start;

                // Ci aspettiamo almeno 4 secondi (2 finestre da 2s)
                expect(duration).toBeGreaterThanOrEqual(4000);
                expect(duration).toBeLessThan(5500); // Buffer generoso
                expect(mockServer.getRequestCount()).toBe(totalRequests);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 15000); // Timeout del test a 15s per sicurezza

        it("should reset quota correctly after a long window expires", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            // Finestra di 2 secondi
            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    quota: { max: 1, window: 2000 },
                },
            });

            try {
                // Consumiamo l'unica quota disponibile
                await pool.request("/test");
                expect(mockServer.getRequestCount()).toBe(1);

                // Aspettiamo che la finestra da 2s scada totalmente
                await wait(2200);

                const start = Date.now();
                await pool.request("/test"); // Deve partire subito ora
                const duration = Date.now() - start;

                expect(duration).toBeLessThan(300); // Risposta immediata
                expect(mockServer.getRequestCount()).toBe(2);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 10000);
    });

    describe("Advanced Rate Limiting & Pipe Thickness", () => {
        it("should distribute requests with a massive auto-calculated minTime", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            // 3 richieste in 3 secondi -> minTime automatico = 1000ms (1 secondo)
            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    minTime: "auto",
                    quota: { max: 3, window: 3000 },
                },
            });

            try {
                const start = Date.now();
                // 3 richieste -> 2 intervalli da 1000ms = 2000ms totali attesi
                for (let i = 0; i < 3; i++) {
                    await pool.request("/slow-distribute");
                }
                const duration = Date.now() - start;

                expect(duration).toBeGreaterThanOrEqual(2000);
                expect(duration).toBeLessThan(3000);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 10000);

        it("should respect concurrency limit with high latency responses", async () => {
            const mockServer = new MockServer();
            // Ogni risposta del server impiega 1.5 secondi
            const baseUrl = await mockServer.start({ latency: 1500 });

            // Solo 2 richieste alla volta
            const pool = new CallPool({
                baseUrl,
                concurrency: { limit: 2 },
            });

            try {
                const start = Date.now();

                /**
                 * 4 richieste totali, concurrency 2:
                 * Batch 1 (R1, R2): Finiscono a 1.5s
                 * Batch 2 (R3, R4): Iniziano a 1.5s, finiscono a 3.0s
                 */
                await Promise.all([pool.request("/c1"), pool.request("/c2"), pool.request("/c3"), pool.request("/c4")]);

                const duration = Date.now() - start;

                // Il tempo totale deve essere circa 3 secondi
                expect(duration).toBeGreaterThanOrEqual(3000);
                expect(duration).toBeLessThan(4500);
                expect(mockServer.getRequestCount()).toBe(4);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 15000);
    });
});
