/** Internal handle for removing an entry without searching the queue. */
export interface QueueEntry<T> {
    index: number;
    value: T | undefined;
}

/**
 * Array-backed FIFO with removable entries. take() and remove() are O(1)
 * amortized. Both consumed prefixes and cancellation holes are compacted,
 * so cancellations behind a blocked head cannot retain an unbounded array.
 */
export class CompactingQueue<T> {
    private items: Array<QueueEntry<T> | undefined> = [];
    private head = 0;
    private count = 0;

    constructor(private readonly compactAt: number) {}

    get size(): number {
        return this.count;
    }

    push(item: T): QueueEntry<T> {
        const entry = { index: this.items.length, value: item };
        this.items.push(entry);
        this.count++;
        return entry;
    }

    take(): T | undefined {
        while (this.head < this.items.length && this.items[this.head] === undefined) this.head++;
        const entry = this.items[this.head];
        if (!entry) return undefined;
        const item = entry.value;
        this.remove(entry);
        return item;
    }

    /** Returns false if the entry was already consumed, removed, or belongs elsewhere. */
    remove(entry: QueueEntry<T>): boolean {
        if (this.items[entry.index] !== entry) return false;
        this.items[entry.index] = undefined;
        if (entry.index === this.head) this.head++;
        entry.index = -1;
        entry.value = undefined;
        this.count--;

        const dead = this.items.length - this.count;
        if (this.count === 0) {
            this.items.length = 0;
            this.head = 0;
        } else if (dead >= this.compactAt && dead * 2 >= this.items.length) {
            const live: Array<QueueEntry<T>> = [];
            for (let index = this.head; index < this.items.length; index++) {
                const item = this.items[index];
                if (item) {
                    item.index = live.length;
                    live.push(item);
                }
            }
            this.items = live;
            this.head = 0;
        }
        return true;
    }

    /** Drains every pending item into `onItem`, then resets the queue. */
    clear(onItem?: (item: T) => void): void {
        const items = this.items;
        this.items = [];
        this.head = 0;
        this.count = 0;
        for (const entry of items) {
            if (entry) {
                const item = entry.value as T;
                entry.index = -1;
                entry.value = undefined;
                onItem?.(item);
            }
        }
    }
}
