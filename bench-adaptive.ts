import { createServer } from "http";
import { AddressInfo } from "net";
import { performance } from "perf_hooks";
import { CallPool } from "./src/index";

// ==========================================
// CONFIG
// ==========================================

const LIMIT = 12; // hard concurrency ceiling for both modes
const VIRTUAL_CLIENTS = 40; // closed-loop drivers during the load phase
const WARMUP_CLIENTS = 2; // low load to establish a clean baseline
const WARMUP_MS = 1_000;
const LOAD_MS = 6_000;
const SEED = 7; // same jitter sequence for both runs -> fair comparison

const SERVER = {
    baseMs: 35, // latency at inflight = 1
    kneeInflight: 6, // comfortable capacity; past this, congestion collapses
    gentlePerInflightMs: 12, // extra latency per in-flight request below the knee
    steepPerInflightMs: 85, // extra latency per in-flight request above the knee
    jitterMs: 12,
    rateLimitPerOver: 0.05, // 429 probability added per in-flight request above the knee
};

// ==========================================
// DETERMINISTIC PRNG (mulberry32)
// ==========================================

function makeRng(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t += 0x6d2b79f5;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

// ==========================================
// CONGESTION SERVER
// Latency grows with the number of in-flight requests (M/M/c-style queueing).
// ==========================================

interface CongestionServer {
    url: string;
    inflight: () => number;
    count429: () => number;
    stop: () => Promise<void>;
}

async function startCongestionServer(): Promise<CongestionServer> {
    const rng = makeRng(SEED);
    let inflight = 0;
    let count429 = 0;

    const server = createServer((req, res) => {
        req.resume(); // drain the request body

        inflight++;
        const active = inflight;
        const jitter = (rng() * 2 - 1) * SERVER.jitterMs;

        // Latency stays gentle up to the knee, then collapses (congestion).
        const belowKnee = Math.min(active, SERVER.kneeInflight);
        const overKnee = Math.max(0, active - SERVER.kneeInflight);
        const latency = Math.max(0, SERVER.baseMs + SERVER.gentlePerInflightMs * (belowKnee - 1) + SERVER.steepPerInflightMs * overKnee + jitter);

        // 429 probability rises the further past the knee we push.
        const throttled = overKnee > 0 && rng() < overKnee * SERVER.rateLimitPerOver;
        if (throttled) count429++;

        setTimeout(() => {
            inflight--;
            if (throttled) {
                res.statusCode = 429;
                res.setHeader("Retry-After", "1");
                res.end(JSON.stringify({ error: "rate limited" }));
                return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
        }, latency);
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://localhost:${port}`,
        inflight: () => inflight,
        count429: () => count429,
        stop: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
    };
}

// ==========================================
// METRICS
// ==========================================

function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}

interface BenchResult {
    mode: "STATIC" | "ADAPTIVE";
    completed: number;
    goodputPerSec: number;
    p50: number;
    p90: number;
    p99: number;
    minConc: number;
    finalConc: number;
    errors: number;
    count429: number;
    timeline: Array<{ t: number; conc: number; inflight: number }>;
}

// ==========================================
// BENCHMARK
// ==========================================

async function runBenchmark(mode: "STATIC" | "ADAPTIVE"): Promise<BenchResult> {
    const server = await startCongestionServer();

    const pool = new CallPool({
        baseUrl: server.url,
        concurrency: { limit: LIMIT },
        retry: { maxAttempts: 3, delay: 200 },
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
    const timeline: BenchResult["timeline"] = [];
    let errors = 0;
    let minConc = LIMIT;
    let running = true;

    const t0 = performance.now();
    const sampler = setInterval(() => {
        const conc = pool.getCurrentConcurrency();
        minConc = Math.min(minConc, conc);
        timeline.push({ t: (performance.now() - t0) / 1000, conc, inflight: server.inflight() });
    }, 250);

    const client = async (): Promise<void> => {
        while (running) {
            const start = performance.now();
            try {
                await pool.request("/");
                latencies.push(performance.now() - start);
            } catch {
                errors++;
            }
        }
    };

    // Phase 1: warm-up at low load so the baseline calibrates on an idle server
    const warmup = Array.from({ length: WARMUP_CLIENTS }, () => client());
    await new Promise(r => setTimeout(r, WARMUP_MS));

    // Phase 2: surge to full load
    const surge = Array.from({ length: VIRTUAL_CLIENTS - WARMUP_CLIENTS }, () => client());
    await new Promise(r => setTimeout(r, LOAD_MS));

    running = false;
    clearInterval(sampler);
    await Promise.all([...warmup, ...surge]);

    const finalConc = pool.getCurrentConcurrency();
    const count429 = server.count429();
    await pool.close();
    await server.stop();

    const elapsedSec = (performance.now() - t0) / 1000;
    return {
        mode,
        completed: latencies.length,
        goodputPerSec: latencies.length / elapsedSec,
        p50: percentile(latencies, 0.5),
        p90: percentile(latencies, 0.9),
        p99: percentile(latencies, 0.99),
        minConc,
        finalConc,
        errors,
        count429,
        timeline,
    };
}

// ==========================================
// REPORTING
// ==========================================

function pad(v: string | number, w: number): string {
    return String(v).padStart(w);
}

function printTable(results: BenchResult[]): void {
    console.log("\n=== A/B RESULT ===\n");
    console.log(`${pad("MODE", 10)}${pad("good/s", 9)}${pad("p50", 8)}${pad("p90", 8)}${pad("p99", 9)}${pad("minConc", 9)}${pad("429", 7)}${pad("errors", 8)}`);
    for (const r of results) {
        console.log(
            `${pad(r.mode, 10)}${pad(r.goodputPerSec.toFixed(1), 9)}${pad(Math.round(r.p50), 8)}${pad(Math.round(r.p90), 8)}${pad(Math.round(r.p99), 9)}${pad(r.minConc, 9)}${pad(r.count429, 7)}${pad(r.errors, 8)}`
        );
    }

    const [staticRes, adaptiveRes] = results;
    const p90Delta = ((adaptiveRes.p90 - staticRes.p90) / staticRes.p90) * 100;
    const goodputDelta = ((adaptiveRes.goodputPerSec - staticRes.goodputPerSec) / staticRes.goodputPerSec) * 100;
    const rlDelta = staticRes.count429 ? ((adaptiveRes.count429 - staticRes.count429) / staticRes.count429) * 100 : 0;

    console.log(`\n-> adaptive vs static: p90 ${p90Delta.toFixed(0)}%, goodput ${goodputDelta.toFixed(0)}%, 429 ${rlDelta.toFixed(0)}%`);
}

function printTimeline(r: BenchResult): void {
    console.log(`\n=== ${r.mode} concurrency over time ===`);
    for (const s of r.timeline) {
        const bar = "#".repeat(Math.max(0, s.conc));
        console.log(`t=${s.t.toFixed(2)}s  conc=${pad(s.conc, 2)}  inflight=${pad(s.inflight, 2)}  ${bar}`);
    }
}

async function main(): Promise<void> {
    console.log("Running STATIC baseline...");
    const staticRes = await runBenchmark("STATIC");

    console.log("Running ADAPTIVE...");
    const adaptiveRes = await runBenchmark("ADAPTIVE");

    printTable([staticRes, adaptiveRes]);
    printTimeline(adaptiveRes);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
