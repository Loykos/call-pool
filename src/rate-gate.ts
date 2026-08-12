import { CompactingQueue } from "./compacting-queue.js";
import { PoolClosedError } from "./errors.js";

interface RateWaiter {
    resolve: () => void;
    reject: (reason: unknown) => void;
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

    private tokens: number;
    private windowIndex = 0;
    private lastStartAt = -Infinity;
    private wakeTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(options: { minTime: number; quota?: { max: number; window: number } }) {
        this.minTime = options.minTime;
        this.quota = options.quota ?? null;
        this.tokens = this.quota?.max ?? Infinity;
    }

    acquire(): Promise<void> {
        if (this.stopped) return Promise.reject(new PoolClosedError());
        return new Promise<void>((resolve, reject) => {
            this.waiters.push({ resolve, reject });
            this.dispatch();
        });
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.clearWakeTimer();

        const closed = new PoolClosedError();
        this.waiters.clear(waiter => waiter.reject(closed));
    }

    private dispatch(): void {
        while (!this.stopped && this.waiters.size > 0) {
            const wait = this.startDelay(performance.now());
            if (wait > 0) return this.wake(wait);

            const waiter = this.waiters.take();
            if (!waiter) return;
            this.lastStartAt = performance.now();
            this.tokens--;
            waiter.resolve();
        }
    }

    private startDelay(now: number): number {
        const spacingWait = this.lastStartAt + this.minTime - now;
        return Math.max(spacingWait, this.quotaWait(now), 0);
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
