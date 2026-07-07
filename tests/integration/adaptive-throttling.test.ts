import { describe, it, expect } from "vitest";
import { CallPool } from "../../src/index";
import { MockServer } from "../setup/mock-server";
import { performance } from "perf_hooks";
import { sleep, percentile, drainPool, createCongestionModel, makeRng } from "../setup/helpers";

describe("CallPool - Adaptive Throttling Integration", () => {
    const TEST_TIMEOUT = 30_000;

    it(
        "should back off below the concurrency ceiling when the server congests",
        async () => {
            const model = createCongestionModel(123);
            const server = new MockServer();

            const url = await server.start({
                onRequestStart: model.onStart,
                onRequestEnd: model.onEnd,
                latency: () => model.latency(20, 40, 15), // base 20ms + 40ms per in-flight + jitter
                headers: { "Content-Type": "application/json" },
                body: { ok: true },
            });

            const pool = new CallPool({
                baseUrl: url,
                concurrency: { limit: 30 },
                adaptive: {
                    enabled: true,
                    useTTFB: true,
                    congestionRatio: 1.4,
                    breachLimit: 2,
                    increaseStep: 20,
                    ignoreBelow: 30,
                },
            });

            // Sample concurrency WHILE the burst is in flight: measuring after the
            // drain would be racy, since recovery pushes concurrency back up as
            // soon as the load clears. We care about the trough it reaches.
            let minConc = 30;
            const sampler = setInterval(() => {
                minConc = Math.min(minConc, pool.getCurrentConcurrency());
            }, 25);

            try {
                const jobs: Promise<unknown>[] = [];
                for (let i = 0; i < 80; i++) {
                    jobs.push(pool.request("/").catch(() => null));
                    if (i % 10 === 0) await sleep(5);
                }
                await Promise.all(jobs);
                await drainPool(pool, 2000);

                // Under congestion the pool must retreat from the ceiling (30)...
                expect(minConc).toBeLessThan(30);
                // ...but never breach the safety floor.
                expect(minConc).toBeGreaterThanOrEqual(1);
            } finally {
                clearInterval(sampler);
                await pool.close();
                await server.stop();
            }
        },
        TEST_TIMEOUT
    );

    it(
        "should beat a static pool on tail latency and goodput when the server congests past its knee",
        async () => {
            const DURATION_MS = 3_500;
            const VIRTUAL_CLIENTS = 40;
            const LIMIT = 12;
            const KNEE = 6; // server capacity; beyond this, latency collapses

            // Latency stays gentle up to KNEE concurrent requests, then rises
            // steeply. Past the knee, adding concurrency LOWERS throughput
            // (congestion collapse) - the regime where adaptive throttling helps.
            const kneeLatency = (rng: () => number, active: number): number => {
                const below = Math.min(active, KNEE);
                const over = Math.max(0, active - KNEE);
                const jitter = (rng() * 2 - 1) * 12;
                return Math.max(0, 40 + 12 * (below - 1) + 85 * over + jitter);
            };

            const runBenchmark = async (mode: "STATIC" | "ADAPTIVE") => {
                const model = createCongestionModel(7);
                const rng = makeRng(7); // same jitter sequence for both modes -> fair comparison
                const server = new MockServer();

                const url = await server.start({
                    onRequestStart: model.onStart,
                    onRequestEnd: model.onEnd,
                    latency: () => kneeLatency(rng, model.getActive()),
                    headers: { "Content-Type": "application/json" },
                    body: { ok: true },
                });

                const pool = new CallPool({
                    baseUrl: url,
                    concurrency: { limit: LIMIT },
                    rateLimit: { minTime: 0 },
                    retry: { maxAttempts: 2, delay: 200 },
                    adaptive:
                        mode === "ADAPTIVE"
                            ? {
                                  enabled: true,
                                  useTTFB: true,
                                  congestionRatio: 2.2,
                                  breachLimit: 2,
                                  decreaseFactor: 0.85,
                                  increaseStep: 1,
                                  ignoreBelow: 25,
                                  minConcurrency: 2,
                              }
                            : { enabled: false },
                });

                const latencies: number[] = [];
                let running = true;

                // Closed-loop driver: a fixed pool of virtual clients, each awaiting
                // its request before starting the next. This bounds in-flight work
                // and yields to the event loop (the old open-loop while-loop never
                // awaited, so it spun synchronously and exhausted the heap).
                const client = async (): Promise<void> => {
                    while (running) {
                        const t0 = performance.now();
                        try {
                            await pool.request("/");
                            latencies.push(performance.now() - t0);
                        } catch {
                            // exhausted retries: a miss, excluded from goodput
                        }
                    }
                };

                const startedAt = performance.now();
                // Warm-up at low load so the baseline calibrates on an idle server.
                const warm = [client(), client()];
                await sleep(800);
                // Surge to full load.
                const surge = Array.from({ length: VIRTUAL_CLIENTS - warm.length }, () => client());
                await sleep(DURATION_MS);

                running = false;
                await Promise.all([...warm, ...surge]);
                const elapsedSec = (performance.now() - startedAt) / 1000;

                await pool.close();
                await server.stop();

                return {
                    mode,
                    completed: latencies.length,
                    goodputPerSec: latencies.length / elapsedSec,
                    p90: percentile(latencies, 0.9),
                };
            };

            const staticRes = await runBenchmark("STATIC");
            const adaptiveRes = await runBenchmark("ADAPTIVE");

            // Holding the ceiling past the knee inflates the tail and wastes
            // throughput; the adaptive pool should find the knee and beat both.
            expect(adaptiveRes.p90).toBeLessThan(staticRes.p90);
            expect(adaptiveRes.completed).toBeGreaterThan(staticRes.completed);
        },
        TEST_TIMEOUT
    );
});
