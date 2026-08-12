import { CompactingQueue } from "./compacting-queue.js";
import { PoolClosedError } from "./errors.js";

interface ScheduledJob {
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

const PRIORITY_LEVELS = 10;
const PRIORITY_BUCKET_COMPACT_AT = 1024;

/**
 * In-process logical-job scheduler: mutable concurrency semaphore and FIFO
 * priority buckets (0 runs first). Rate constraints live in RateGate because
 * they apply to every HTTP attempt, including retries.
 *
 * Job starts are driven by completions with no polling. The queue is unbounded
 * by design: backpressure belongs to the caller.
 */
export class RequestScheduler {
    private maxConcurrent: number;

    private readonly queues = Array.from({ length: PRIORITY_LEVELS }, () => new CompactingQueue<ScheduledJob>(PRIORITY_BUCKET_COMPACT_AT));
    private runningCount = 0;

    private stopped = false;
    private onDrained: (() => void) | null = null;

    constructor(options: { maxConcurrent: number }) {
        this.maxConcurrent = options.maxConcurrent;
    }

    get queued(): number {
        return this.queues.reduce((total, bucket) => total + bucket.size, 0);
    }

    get running(): number {
        return this.runningCount;
    }

    schedule<T>(priority: number, task: () => Promise<T>): Promise<T> {
        if (this.stopped) return Promise.reject(new PoolClosedError());
        return new Promise<T>((resolve, reject) => {
            this.queues[priority].push({ task, resolve: resolve as (value: unknown) => void, reject });
            this.dispatch();
        });
    }

    setMaxConcurrent(limit: number): void {
        this.maxConcurrent = limit;
        this.dispatch();
    }

    /** Rejects every queued job and resolves once in-flight jobs have settled. */
    stop(): Promise<void> {
        this.stopped = true;

        const closed = new PoolClosedError();
        for (const bucket of this.queues) {
            bucket.clear(job => job.reject(closed));
        }

        if (this.runningCount === 0) return Promise.resolve();
        return new Promise(resolve => {
            this.onDrained = resolve;
        });
    }

    private dispatch(): void {
        while (this.runningCount < this.maxConcurrent) {
            const job = this.takeNext();
            if (!job) return;

            this.runningCount++;
            job.task().then(job.resolve, job.reject).finally(() => this.onJobSettled());
        }
    }

    private takeNext(): ScheduledJob | undefined {
        for (const bucket of this.queues) {
            const job = bucket.take();
            if (job) return job;
        }
        return undefined;
    }

    private onJobSettled(): void {
        this.runningCount--;
        if (!this.stopped) return this.dispatch();
        if (this.runningCount === 0) this.onDrained?.();
    }
}
