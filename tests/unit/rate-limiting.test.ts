import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

describe.concurrent("Rate Limiting", () => {
    describe("Fixed minTime (Manual Throttling)", () => {
        it("should respect a generous minTime between parallel requests", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            // 400ms di attesa tra una richiesta e l'altra
            const pool = new CallPool({
                baseUrl,
                rateLimit: { minTime: 400 },
            });

            try {
                const start = Date.now();
                // T0: R1 parte subito
                // T400: R2 parte
                // T800: R3 parte
                await Promise.all([pool.request("/1"), pool.request("/2"), pool.request("/3")]);
                const duration = Date.now() - start;

                // Ci aspettiamo almeno 800ms (2 intervalli da 400ms)
                // Usiamo una tolleranza conservativa
                expect(duration).toBeGreaterThanOrEqual(750);
                expect(mockServer.getRequestCount()).toBe(3);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should handle minTime: 0 without any artificial delay", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();
            const pool = new CallPool({
                baseUrl,
                rateLimit: { minTime: 0 },
            });

            try {
                const start = Date.now();
                await Promise.all([pool.request("/1"), pool.request("/2"), pool.request("/3")]);
                const duration = Date.now() - start;

                // Senza limite, dovrebbero volerci pochissimi ms
                expect(duration).toBeLessThan(200);
                expect(mockServer.getRequestCount()).toBe(3);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });

    describe("Auto minTime calculation (Quota-based)", () => {
        it("should distribute requests with auto-calculated 1-second interval", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            // Quota: 2 richieste in 2 secondi -> minTime automatico di 1000ms
            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    minTime: "auto",
                    quota: { max: 2, window: 2000 },
                },
            });

            try {
                const start = Date.now();
                await pool.request("/1"); // Parte a 0ms
                await pool.request("/2"); // Dovrebbe partire a 1000ms
                const duration = Date.now() - start;

                // Verifichiamo che l'attesa sia stata di circa 1 secondo
                expect(duration).toBeGreaterThanOrEqual(950);
                expect(duration).toBeLessThan(1500); // Evitiamo che sia andato troppo oltre
                expect(mockServer.getRequestCount()).toBe(2);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });

        it("should fail early if configuration is invalid", () => {
            expect(() => {
                new CallPool({
                    baseUrl: "http://localhost",
                    rateLimit: { minTime: "auto" },
                    // Manca la quota!
                });
            }).toThrow(/Cannot set minTime to 'auto' without defining a 'quota'/);
        });
    });

    describe("Long Sequential Stability", () => {
        it("should accumulate significant delay over a sequence of requests", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start();

            // 300ms di intervallo
            const pool = new CallPool({
                baseUrl,
                rateLimit: { minTime: 300 },
            });

            try {
                const start = Date.now();
                // 5 richieste = 4 intervalli da 300ms = 1200ms totali
                for (let i = 0; i < 5; i++) {
                    await pool.request(`/seq-${i}`);
                }
                const duration = Date.now() - start;

                expect(duration).toBeGreaterThanOrEqual(1150);
                expect(mockServer.getRequestCount()).toBe(5);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        });
    });
});
