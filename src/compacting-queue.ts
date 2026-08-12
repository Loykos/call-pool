/**
 * Array-backed FIFO with a moving head pointer: take() is O(1) amortized.
 * Consumed slots are nulled out and the backing array is compacted once the
 * dead prefix grows past `compactAt` and covers at least half of the array,
 * so long-lived queues never leak settled entries.
 */
export class CompactingQueue<T> {
    private items: Array<T | undefined> = [];
    private head = 0;

    constructor(private readonly compactAt: number) {}

    get size(): number {
        return this.items.length - this.head;
    }

    push(item: T): void {
        this.items.push(item);
    }

    take(): T | undefined {
        if (this.head >= this.items.length) return undefined;

        const item = this.items[this.head];
        this.items[this.head] = undefined;
        this.head++;

        if (this.head === this.items.length) {
            this.items.length = 0;
            this.head = 0;
        } else if (this.head >= this.compactAt && this.head * 2 >= this.items.length) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }

        return item;
    }

    /** Drains every pending item into `onItem`, then resets the queue. */
    clear(onItem?: (item: T) => void): void {
        if (onItem) {
            for (let index = this.head; index < this.items.length; index++) {
                const item = this.items[index];
                if (item !== undefined) onItem(item);
            }
        }
        this.items.length = 0;
        this.head = 0;
    }
}
