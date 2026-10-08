import { CompactingQueue } from "./compacting-queue.js";
import { PoolClosedError } from "./errors.js";
import { RequestDeadline } from "./request-deadline.js";

interface RateWaiter {
    resolve: () => void;
    reject: (reason: unknown) => void;
    cleanupAbort?: () => void;
}

const RATE_QUEUE_COMPACT_AT = 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Serializes permission to start individual HTTP attempts. Unlike the request
 * scheduler, this gate is entered again for every retry so contractual limits
 * count actual upstream traffic rather than logical jobs.
 */
export class RateGate {
    private readonly minTime: number;
    private readonly quota: { max: number; window: number } | null;
    private readonly epoch = performance.now();
    private readonly waiters = new CompactingQueue<RateWaiter>(RATE_QUEUE_COMPACT_AT);
    private readonly deadlines = new Set<RequestDeadline>();

    private tokens: number;
    private windowIndex = 0;
    private lastStartAt = -Infinity;
    private pausedUntil = -Infinity;
    private wakeTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(options: { minTime: number; quota?: { max: number; window: number } }) {
        this.minTime = options.minTime;
        this.quota = options.quota ?? null;
        this.tokens = this.quota?.max ?? Infinity;
    }

    acquire(signal?: AbortSignal, deadline?: RequestDeadline): Promise<void> {
        signal = deadline?.signal ?? signal;
        if (this.stopped) return Promise.reject(new PoolClosedError());
        if (signal?.aborted) return Promise.reject(signal.reason);
        return new Promise<void>((resolve, reject) => {
            const waiter: RateWaiter = { resolve, reject };
            const entry = this.waiters.push(waiter);
            if (deadline) this.deadlines.add(deadline);
            if (signal) {
                const onAbort = () => {
                    if (!this.waiters.remove(entry)) return;
                    waiter.cleanupAbort?.();
                    if (this.waiters.size === 0) this.clearWakeTimer();
                    reject(signal.reason);
                };
                waiter.cleanupAbort = () => {
                    signal.removeEventListener("abort", onAbort);
                    if (deadline) this.deadlines.delete(deadline);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }
            this.dispatch();
        });
    }

    /**
     * Holds every attempt not yet started until `until` (a `performance.now()`
     * timestamp). A pause only ever extends: an earlier deadline is ignored.
     */
    pauseUntil(until: number): void {
        if (this.stopped || until <= this.pausedUntil) return;
        this.pausedUntil = until;
        // A pending wake was computed without the pause: start over from now.
        this.clearWakeTimer();
        this.dispatch();
    }

    /** Milliseconds left in the current pause, 0 when not paused. */
    pausedFor(now: number = performance.now()): number {
        return Math.max(0, this.pausedUntil - now);
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.clearWakeTimer();

        const closed = new PoolClosedError();
        this.waiters.clear(waiter => {
            waiter.cleanupAbort?.();
            waiter.reject(closed);
        });
    }

    private dispatch(): void {
        while (!this.stopped && this.waiters.size > 0) {
            const wait = this.startDelay(performance.now());
            // Recheck all waiting budgets when a later 429 extends the pause.
            // Abort synchronously removes each waiter through its listener.
            for (const deadline of this.deadlines) deadline.checkWait(wait);
            if (this.waiters.size === 0) return;
            if (wait > 0) return this.wake(wait);

            const waiter = this.waiters.take();
            if (!waiter) return;
            waiter.cleanupAbort?.();
            this.lastStartAt = performance.now();
            this.tokens--;
            waiter.resolve();
        }
    }

    private startDelay(now: number): number {
        const spacingWait = this.lastStartAt + this.minTime - now;
        return Math.max(spacingWait, this.quotaWait(now), this.pausedUntil - now, 0);
    }

    private quotaWait(now: number): number {
        if (!this.quota) return 0;

        const elapsedWindows = Math.floor((now - this.epoch) / this.quota.window);
        if (elapsedWindows > this.windowIndex) {
            this.windowIndex = elapsedWindows;
            this.tokens = this.quota.max;
        }

        if (this.tokens > 0) return 0;
        return this.epoch + (this.windowIndex + 1) * this.quota.window - now;
    }

    private wake(delayMs: number): void {
        if (this.wakeTimer) return;
        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.dispatch();
        }, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    }

    private clearWakeTimer(): void {
        if (!this.wakeTimer) return;
        clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
    }
}
