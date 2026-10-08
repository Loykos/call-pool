import { matchesCode, parseRetryAfter } from "./http-policy.js";
import type { CircuitBreakerOptions, CircuitBreakerState, StatusCodeSelector } from "./types.js";

/** A permission belongs to exactly one state generation, not just a request. */
export interface CircuitPermit {
    generation: number;
    probe: boolean;
    settled: boolean;
}

/** State only; RateGate owns admission, waiting, timers and cancellation. */
export class CircuitBreaker {
    private state: Exclude<CircuitBreakerState, "disabled"> = "closed";
    private generation = 0;
    private openedFrom = -1;
    private openUntil = -Infinity;
    private failures = 0;
    private successes = 0;
    private activeProbes = 0;
    private readonly codes: readonly StatusCodeSelector[];
    private readonly failureThreshold: number;
    private readonly after: number;
    private readonly maxRetryAfter: number;
    private readonly maxConcurrent: number;
    private readonly successThreshold: number;
    onChange?: () => void;

    constructor(options: CircuitBreakerOptions) {
        this.codes = [...(options.codes ?? [403, 429, 503])];
        this.failureThreshold = options.failureThreshold ?? 3;
        this.after = options.halfOpen?.after ?? 10_000;
        this.maxRetryAfter = options.halfOpen?.maxRetryAfter ?? 60_000;
        this.maxConcurrent = options.halfOpen?.maxConcurrent ?? 1;
        this.successThreshold = options.halfOpen?.successThreshold ?? 2;
    }

    getState(): CircuitBreakerState {
        this.refresh();
        return this.state;
    }

    pausedFor(): number {
        this.refresh();
        return this.state === "open" ? Math.max(0, this.openUntil - performance.now()) : 0;
    }

    /** Called atomically with quota/spacing admission by RateGate. */
    acquire(): CircuitPermit | null {
        this.refresh();
        if (this.state === "open") return null;
        const probe = this.state === "half-open";
        // Once enough probes succeeded, drain the remaining probes before
        // closing: their late failures must still be able to reopen the circuit.
        if (probe && (this.activeProbes >= this.maxConcurrent || this.successes >= this.successThreshold)) return null;
        if (probe) this.activeProbes++;
        return { generation: this.generation, probe, settled: false };
    }

    /**
     * Only completed successful responses count as recovery. Cancellation,
     * transport/parser failures and non-matching HTTP errors release permission
     * without contributing success or failure to this HTTP-code policy.
     */
    complete(permit: CircuitPermit, status?: number, retryAfter?: string | string[], succeeded = false): void {
        if (permit.settled) return;
        permit.settled = true;
        const failed = status !== undefined && matchesCode(status, this.codes);
        if (permit.generation !== this.generation) {
            // Refusals from the closed generation that opened this circuit can
            // extend that same open period; stale probes never affect a new one.
            if (failed && this.state === "open" && !permit.probe && permit.generation === this.openedFrom) {
                this.openUntil = Math.max(this.openUntil, performance.now() + this.wait(retryAfter));
                this.onChange?.();
            }
            return;
        }
        if (permit.probe) this.activeProbes--;
        if (failed) {
            this.failures++;
            if (permit.probe || this.failures >= this.failureThreshold) this.open(permit.generation, retryAfter);
        } else if (succeeded) {
            this.failures = 0;
            if (permit.probe) this.successes++;
        }
        if (this.state === "half-open" && this.successes >= this.successThreshold && this.activeProbes === 0) {
            this.state = "closed";
            this.generation++;
            this.failures = 0;
            this.successes = 0;
        }
        this.onChange?.();
    }

    private wait(retryAfter?: string | string[]): number {
        return parseRetryAfter(retryAfter, this.maxRetryAfter) ?? this.after;
    }

    private open(from: number, retryAfter?: string | string[]): void {
        this.state = "open";
        this.openedFrom = from;
        this.generation++;
        this.openUntil = performance.now() + this.wait(retryAfter);
        this.successes = 0;
        this.activeProbes = 0;
    }

    private refresh(): void {
        if (this.state !== "open" || performance.now() < this.openUntil) return;
        this.state = "half-open";
        this.generation++;
        this.successes = 0;
        this.activeProbes = 0;
    }
}
