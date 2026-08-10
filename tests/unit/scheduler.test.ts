import { afterEach, describe, expect, it, vi } from "vitest";
import { CallPool } from "../../src/index";

interface SchedulerHarness {
    readonly queued: number;
    schedule<T>(priority: number, task: () => Promise<T>): Promise<T>;
    setMaxConcurrent(limit: number): void;
    takeNext(): { task: () => Promise<unknown> } | undefined;
}

function createScheduler(options: ConstructorParameters<typeof CallPool>[0] = { baseUrl: "http://localhost" }) {
    const pool = new CallPool(options);
    const scheduler = (pool as unknown as { scheduler: SchedulerHarness }).scheduler;
    return { pool, scheduler };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("RequestScheduler regressions", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        ["quota-window", { quota: { max: 1, window: 2_600_000_000 } }],
        ["minTime", { minTime: 2_600_000_000 }],
    ] as const)("chunks %s waits that exceed Node's maximum timer delay", async (_scenario, rateLimit) => {
        vi.useFakeTimers();
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const { pool, scheduler } = createScheduler({
            baseUrl: "http://localhost",
            concurrency: { limit: 1 },
            rateLimit,
        });

        const first = scheduler.schedule(5, async () => undefined);
        const second = scheduler.schedule(5, async () => undefined);
        const secondError = second.catch(error => error as Error);

        await first;
        await flushMicrotasks();

        const scheduledDelays = timeoutSpy.mock.calls.map(([, delay]) => Number(delay));
        expect(scheduledDelays).toContain(2_147_483_647);
        expect(scheduledDelays.every(delay => delay <= 2_147_483_647)).toBe(true);

        await pool.close();
        await expect(secondError).resolves.toMatchObject({ message: "[CallPool] Pool is closed" });
    });

    it("dequeues a large priority bucket in amortized constant time", async () => {
        const { pool, scheduler } = createScheduler();
        scheduler.setMaxConcurrent(0);

        const jobCount = 100_000;
        for (let index = 0; index < jobCount; index++) {
            void scheduler.schedule(5, async () => index);
        }

        expect(scheduler.queued).toBe(jobCount);

        let firstJob: ReturnType<SchedulerHarness["takeNext"]>;
        let lastJob: ReturnType<SchedulerHarness["takeNext"]>;
        const startedAt = performance.now();
        for (let index = 0; index < jobCount; index++) {
            const job = scheduler.takeNext();
            if (!job) throw new Error(`Missing queued job at index ${index}`);
            if (index === 0) firstJob = job;
            if (index === jobCount - 1) lastJob = job;
        }
        const elapsedMs = performance.now() - startedAt;

        expect(scheduler.queued).toBe(0);
        expect(await firstJob!.task()).toBe(0);
        expect(await lastJob!.task()).toBe(jobCount - 1);
        expect(elapsedMs).toBeLessThan(250);

        await pool.close();
    });
});
