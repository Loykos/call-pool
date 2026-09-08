import { describe, expect, it } from "vitest";
import { CompactingQueue, type QueueEntry } from "../../src/compacting-queue";

describe("Removable FIFO entries", () => {
    it("keeps handles valid across compaction and rejects stale or foreign handles", () => {
        const queue = new CompactingQueue<number>(2);
        const entries = Array.from({ length: 8 }, (_, index) => queue.push(index));
        for (const index of [1, 3, 5, 6]) expect(queue.remove(entries[index])).toBe(true);
        expect(queue.remove(entries[4])).toBe(true);
        expect(queue.remove(entries[4])).toBe(false);
        const other = new CompactingQueue<number>(2);
        expect(other.remove(entries[0])).toBe(false);
        expect([queue.take(), queue.take(), queue.take(), queue.take()]).toEqual([0, 2, 7, undefined]);
        expect(queue.size).toBe(0);
        for (const entry of entries) {
            expect(entry.value).toBeUndefined();
            expect(queue.remove(entry)).toBe(false);
        }
        queue.push(8);
        expect(queue.remove(entries[0])).toBe(false);
        expect(queue.take()).toBe(8);
    });

    it("clears only live entries and invalidates handles even when values repeat", () => {
        const queue = new CompactingQueue<object>(2);
        const value = {};
        const first = queue.push(value);
        const second = queue.push(value);
        const third = queue.push(value);
        expect(queue.remove(second)).toBe(true);
        const cleared: object[] = [];
        queue.clear(item => cleared.push(item));
        expect(cleared).toEqual([value, value]);
        expect(queue.size).toBe(0);
        expect(first.value).toBeUndefined();
        expect(third.value).toBeUndefined();
        expect(queue.remove(first)).toBe(false);
        expect(queue.take()).toBeUndefined();
    });

    it("matches a FIFO model through interleaved insertion, cancellation, draining and clearing", () => {
        const queue = new CompactingQueue<number>(4);
        const model: Array<{ value: number; entry: QueueEntry<number> }> = [];
        let state = 42;
        for (let step = 0; step < 5000; step++) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            const operation = state % 10;
            if (operation < 5) {
                model.push({ value: step, entry: queue.push(step) });
            } else if (operation < 8 && model.length > 0) {
                const [removed] = model.splice(state % model.length, 1);
                expect(queue.remove(removed.entry)).toBe(true);
                expect(removed.entry.value).toBeUndefined();
            } else if (operation === 9 && step % 31 === 0) {
                const drained: number[] = [];
                queue.clear(item => drained.push(item));
                expect(drained).toEqual(model.map(item => item.value));
                model.length = 0;
            } else {
                expect(queue.take()).toBe(model.shift()?.value);
            }
            expect(queue.size).toBe(model.length);
        }
        const remaining: number[] = [];
        queue.clear(item => remaining.push(item));
        expect(remaining).toEqual(model.map(item => item.value));
    });

    it("bounds backing storage when repeated cancellations happen behind an untouched head", () => {
        const queue = new CompactingQueue<number>(16);
        const head = queue.push(-1);
        for (let round = 0; round < 100; round++) {
            const entries = Array.from({ length: 100 }, (_, index) => queue.push(index));
            for (const entry of entries) queue.remove(entry);
            expect(queue.size).toBe(1);
            expect((queue as unknown as { items: unknown[] }).items.length).toBeLessThanOrEqual(32);
        }
        expect(queue.take()).toBe(-1);
        expect(queue.remove(head)).toBe(false);
    });
});
