import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

const now = () => Date.now();

describe("Adaptive Throttling - Full Validation", () => {
    describe("Spike Detection & Reaction", () => {
        it("should update internal state and reduce concurrency after a spike", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                latency: () => {
                    if (mockServer.getRequestCount() <= 3) return 180; // Normali sopra ignoreBelow
                    if (mockServer.getRequestCount() === 4) return 1500; // Spike improvviso
                    return 180; // Healthy ma non "trivially fast"
                },
            });

            const pool = new CallPool({
                baseUrl,
                concurrency: {
                    limit: 10
                },
                adaptive: {
                    enabled: true,
                    congestionRatio: 2,
                    breachLimit: 1
                }
            });

            try {
                // 1. Warm-up
                for (let i = 0; i < 3; i++) await pool.request("/warmup");
                expect(pool.getCurrentConcurrency()).toBe(10);

                // 2. Lanciamo lo Spike (1500ms > avgLatency * 2 = ~360ms)
                // Dovrebbe attivare reduceConcurrency: min(10*0.9, 10-1) = min(9, 9) = 9
                await pool.request("/spike");

                // --- CONTROLLO STATO ---
                // Dovrebbe aver ridotto la concurrency da 10 a 9
                expect(pool.getCurrentConcurrency()).toBe(9);

                // --- CONTROLLO RECOVERY ---
                // Dopo lo spike, le richieste healthy sopra ignoreBelow devono recuperare.
                await pool.request("/check-1");
                expect(pool.getCurrentConcurrency()).toBe(10);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 20000);
    });

    describe("Recovery & Soft Landing", () => {
        it("should demonstrate gradual recovery after congestion clears", async () => {
            const mockServer = new MockServer();

            const baseUrl = await mockServer.start({
                latency: () => {
                    if (mockServer.getRequestCount() === 1) return 100; // Baseline
                    if (mockServer.getRequestCount() === 2) return 3000; // Spike
                    return 100; // Torna veloce
                },
            });

            const pool = new CallPool({
                baseUrl,
                concurrency: {
                    limit: 10
                },
                adaptive: {
                    enabled: true,
                    congestionRatio: 1.5, // 3000 > avg * 1.5 attiva riduzione
                    breachLimit: 1,
                    increaseStep: 1, // Aumenta di 1 per ogni richiesta veloce
                    decreaseFactor: 0.9, // Riduce del 10% o di almeno 1
                    ignoreBelow: 150, // Richieste sotto 150ms sono veloci
                },
            });

            try {
                // --- FASE 1: BASELINE ---
                await pool.request("/baseline");
                expect(pool.getCurrentConcurrency()).toBe(10);

                // --- FASE 2: SPIKE ---
                // 3000ms > (avgLatency ~100ms * 1.5). Attiva reduceConcurrency
                // min(10*0.9, 10-1) = min(9, 9) = 9
                await pool.request("/spike");
                expect(pool.getCurrentConcurrency()).toBe(9);

                // --- FASE 3: RECOVERY (Aumento graduale) ---
                // Richieste veloci (< ignoreBelow 150ms) dovrebbero aumentare gradualmente
                await pool.request("/cool-1");
                await new Promise(r => setTimeout(r, 300)); // Aspetta debounce
                // Dovrebbe essere aumentata a 10 (o almeno 9 se non ancora processata)
                expect(pool.getCurrentConcurrency()).toBeGreaterThanOrEqual(9);

                await pool.request("/cool-2");
                await new Promise(r => setTimeout(r, 300));
                // Dovrebbe essere tornata a 10
                expect(pool.getCurrentConcurrency()).toBe(10);

                // Verifica che le richieste consecutive siano veloci
                const start = now();
                await pool.request("/base-1");
                await pool.request("/base-2");
                const duration = now() - start;
                // Con concurrency 10, entrambe possono partire in parallelo
                // Quindi durata ~= max(100ms, 100ms) = ~100ms
                expect(duration).toBeLessThan(250); // Tornato veloce
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 30000);
    });

    describe("Safety Caps (Min/Max)", () => {
        it("should cap the concurrency reduction even with repeated spikes", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                latency: () => {
                    if (mockServer.getRequestCount() <= 1) return 100; // Baseline
                    return 300; // Spike costante (300ms > baseline 100ms * 1.1 = congestione)
                },
            });

            const pool = new CallPool({
                baseUrl,
                concurrency: {
                    limit: 10
                },
                adaptive: {
                    enabled: true,
                    congestionRatio: 1.1,
                    breachLimit: 1,
                    decreaseFactor: 0.9,
                    minConcurrency: 3, // Non può scendere sotto 3
                },
            });

            try {
                await pool.request("/spike-1"); // Stabilisce baseline
                expect(pool.getCurrentConcurrency()).toBe(10);

                // Spike 1: 10 -> min(10*0.9, 10-1) = 9
                await pool.request("/spike-2");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(9);

                // Spike 2: 9 -> min(9*0.9, 9-1) = min(8.1, 8) = 8
                await pool.request("/spike-3");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(8);

                // Spike 3: 8 -> min(8*0.9, 8-1) = min(7.2, 7) = 7
                // Continuiamo fino a raggiungere il cap
                await pool.request("/spike-4");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(7);

                await pool.request("/spike-5");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(6);

                await pool.request("/spike-6");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(5);

                await pool.request("/spike-7");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(4);

                await pool.request("/spike-8");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(3);

                // Spike 9: Dovrebbe restare a 3 (minConcurrency cap)
                await pool.request("/spike-9");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(3);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 30000);

        it("should respect custom minConcurrency configuration", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                latency: () => {
                    const count = mockServer.getRequestCount();
                    // Prime 3 richieste veloci per stabilire baseline
                    if (count <= 3) return 100;
                    // Poi richieste lente per attivare throttling progressivo
                    return 500; // Latenza alta per attivare throttling
                },
            });

            const pool = new CallPool({
                baseUrl,
                concurrency: {
                    limit: 10
                },
                adaptive: {
                    enabled: true,
                    congestionRatio: 2.0, // 500 > 100 * 2, quindi attiva throttling
                    breachLimit: 1,
                    decreaseFactor: 0.8, // Riduce del 20% ogni volta
                    minConcurrency: 5, // Cap personalizzato: non scende sotto 5
                },
            });

            try {
                // Warm-up: 3 richieste veloci per stabilire baseline (avgLatency ~100ms)
                await pool.request("/warmup-1");
                await pool.request("/warmup-2");
                await pool.request("/warmup-3");
                expect(pool.getCurrentConcurrency()).toBe(10);

                // Spike 1: 10 -> min(10*0.8, 10-1) = min(8, 9) = 8 -> floor(8) = 8
                await pool.request("/spike-1");
                await new Promise(r => setTimeout(r, 350)); // Aspetta debounce
                expect(pool.getCurrentConcurrency()).toBe(8);

                // Spike 2: 8 -> min(8*0.8, 8-1) = min(6.4, 7) = 6.4 -> max(6.4, 5) = 6.4 -> floor(6.4) = 6
                await pool.request("/spike-2");
                await new Promise(r => setTimeout(r, 350)); // Aspetta debounce
                expect(pool.getCurrentConcurrency()).toBe(6);

                // Spike 3: 6 -> min(6*0.8, 6-1) = min(4.8, 5) = 4.8 -> max(4.8, 5) = 5 -> floor(5) = 5 (raggiunge il cap)
                await pool.request("/spike-3");
                await new Promise(r => setTimeout(r, 350)); // Aspetta debounce
                expect(pool.getCurrentConcurrency()).toBe(5);

                // Spike 4: Dovrebbe restare a 5 (minConcurrency cap)
                await pool.request("/spike-4");
                await new Promise(r => setTimeout(r, 300));
                expect(pool.getCurrentConcurrency()).toBe(5);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 30000);
    });
});
