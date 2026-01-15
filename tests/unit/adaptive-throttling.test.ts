import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";

const now = () => Date.now();

describe.concurrent("Adaptive Throttling - Full Validation", () => {
    describe("Spike Detection & Reaction", () => {
        it("should update internal state and increase request duration after a spike", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                latency: () => {
                    if (mockServer.getRequestCount() <= 3) return 120; // Normali (120ms)
                    if (mockServer.getRequestCount() === 4) return 1500; // Spike improvviso (1500ms)
                    return 120; // Torna veloce (120ms)
                },
            });

            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    minTime: 10,
                    enableAdaptiveThrottling: true,
                    congestionThreshold: 2.0,
                },
            });

            try {
                // 1. Warm-up
                for (let i = 0; i < 3; i++) await pool.request("/warmup");
                expect(pool.getCurrentMinTime()).toBe(10);

                // 2. Lanciamo lo Spike
                await pool.request("/spike");

                // --- CONTROLLO STATO ---
                // Dovrebbe aver attivato increaseDelay() -> max(10*2, 200) = 200ms
                expect(pool.getCurrentMinTime()).toBe(200);

                // --- CONTROLLO DURATION ---
                // Facciamo due richieste veloci consecutive
                const start = now();
                await pool.request("/check-1"); // Parte subito
                await pool.request("/check-2"); // Deve aspettare 200ms + 120ms latenza
                const duration = now() - start;

                /**
                 * Calcolo atteso:
                 * Max(minTime 200ms, Latency 120ms) + Latency 120ms = 320ms
                 * Usiamo 310ms come soglia di sicurezza per il test.
                 */
                expect(duration).toBeGreaterThanOrEqual(310);
                expect(duration).toBeLessThan(450); // Buffer superiore
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 20000);
    });

    describe("Recovery & Soft Landing", () => {
        it("should demonstrate a gradual Soft Landing after congestion clears", async () => {
            const mockServer = new MockServer();

            const baseUrl = await mockServer.start({
                latency: () => {
                    if (mockServer.getRequestCount() === 1) return 500;
                    if (mockServer.getRequestCount() === 2) return 3000;
                    return 500;
                },
            });

            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    minTime: 500, // baseMinTime
                    enableAdaptiveThrottling: true,
                    congestionThreshold: 1.5,
                    recoveryFactor: 0.8,
                },
            });

            try {
                // --- FASE 1: BASELINE ---
                await pool.request("/baseline");
                expect(pool.getCurrentMinTime()).toBe(500);

                // --- FASE 2: SPIKE ---
                // 3000ms > (500 * 1.5). Attiva increaseDelay: 500 * 2 = 1000ms
                await pool.request("/spike");
                expect(pool.getCurrentMinTime()).toBe(1000);

                // --- FASE 3: SOFT LANDING (Discesa graduale) ---

                // Richiesta di raffreddamento 1: 1000 * 0.8 = 800ms
                await pool.request("/cool-1");
                expect(pool.getCurrentMinTime()).toBe(800);

                // Verifica Duration dopo il primo step di landing
                // Calcolo teorico: Intervallo (800) + Latenza (500) = 1300ms
                const start1 = now();
                await pool.request("/check-1"); // Inizia T0
                await pool.request("/check-2"); // Inizia T800, finisce T1300
                const duration1 = now() - start1;
                expect(duration1).toBeGreaterThanOrEqual(1250);

                expect(pool.getCurrentMinTime()).toBe(512);
                // Richiesta di raffreddamento 2: 800 * 0.8 = 640ms
                await pool.request("/cool-2");
                // Verifica finale Duration al valore base
                expect(pool.getCurrentMinTime()).toBe(500);

                // Calcolo: Intervallo (500) + Latenza (500) = 1000ms
                const start2 = now();
                await pool.request("/base-1");
                await pool.request("/base-2");
                const duration2 = now() - start2;
                expect(duration2).toBeLessThan(1200); // Tornato veloce
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 30000);
    });

    describe("Safety Caps (Min/Max)", () => {
        it("should cap the adaptive delay even with repeated spikes", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                latency: () => {
                    if (mockServer.getRequestCount() == 1) return 2000;
                    return 4000;
                },
            });

            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    minTime: 2000,
                    enableAdaptiveThrottling: true,
                    congestionThreshold: 1.1,
                    recoveryFactor: 0.8,
                },
            });

            try {
                await pool.request("/spike-1"); // Niente rallentamento
                await pool.request("/spike-2"); // 2000 -> 4000
                expect(pool.getCurrentMinTime()).toBe(4000);

                await pool.request("/spike-3"); // 4000 -> 5000
                expect(pool.getCurrentMinTime()).toBe(5000);
                await pool.request("/spike-3"); // Resta a 5000 (CAP)
                expect(pool.getCurrentMinTime()).toBe(5000);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 30000);

        it("should respect custom maxMinTime configuration", async () => {
            const mockServer = new MockServer();
            const baseUrl = await mockServer.start({
                latency: () => {
                    const count = mockServer.getRequestCount();
                    // Prime 3 richieste veloci per stabilire baseline
                    if (count <= 3) return 150;
                    // Poi richieste lente per attivare throttling progressivo
                    return 1000; // Latenza alta per attivare throttling
                },
            });

            const pool = new CallPool({
                baseUrl,
                rateLimit: {
                    minTime: 100,
                    enableAdaptiveThrottling: true,
                    congestionThreshold: 2.0, // 1000 > 150 * 2, quindi attiva throttling
                    recoveryFactor: 0.8,
                    maxMinTime: 800, // Cap personalizzato
                },
            });

            try {
                // Warm-up: 3 richieste veloci per stabilire baseline (avgLatency ~150ms)
                await pool.request("/warmup-1");
                await pool.request("/warmup-2");
                await pool.request("/warmup-3");
                expect(pool.getCurrentMinTime()).toBe(100);

                // Spike 1: 100 -> max(100*2, 200) = 200
                await pool.request("/spike-1");
                expect(pool.getCurrentMinTime()).toBe(200);

                // Spike 2: 200 -> 400
                await pool.request("/spike-2");
                expect(pool.getCurrentMinTime()).toBe(400);

                // Spike 3: 400 -> 800 (cap)
                await pool.request("/spike-3");
                expect(pool.getCurrentMinTime()).toBe(800);

                // Spike 4: Resta a 800 (CAP personalizzato)
                await pool.request("/spike-4");
                expect(pool.getCurrentMinTime()).toBe(800);
            } finally {
                await Promise.all([pool.close(), mockServer.stop()]);
            }
        }, 30000);
    });
});
