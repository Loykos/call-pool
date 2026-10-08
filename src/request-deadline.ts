import { CallPoolTimeoutError } from "./errors.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** One budget for the whole logical request, using the same clock as RateGate. */
export class RequestDeadline {
    private readonly controller = new AbortController();
    readonly signal: AbortSignal = this.controller.signal;
    private readonly expiresAt: number;
    private timer: NodeJS.Timeout | null = null;
    private readonly onCallerAbort = () => this.abort(this.callerSignal!.reason);

    constructor(private readonly maxElapsedTime: number, private readonly callerSignal?: AbortSignal) {
        this.expiresAt = performance.now() + maxElapsedTime;
        if (callerSignal?.aborted) {
            this.abort(callerSignal.reason);
        } else {
            callerSignal?.addEventListener("abort", this.onCallerAbort, { once: true });
            this.armTimer();
        }
    }

    /** Abort rather than waiting when there is no time left after a known wait. */
    checkWait(waitMs: number, cause?: unknown): void {
        if (!this.signal.aborted && waitMs >= this.expiresAt - performance.now()) {
            this.abort(new CallPoolTimeoutError(this.maxElapsedTime, cause));
        }
    }

    assertCanWait(waitMs: number, cause?: unknown): void {
        this.checkWait(waitMs, cause);
        this.signal.throwIfAborted();
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.callerSignal?.removeEventListener("abort", this.onCallerAbort);
    }

    private abort(reason: unknown): void {
        this.dispose();
        this.controller.abort(reason);
    }

    private armTimer(): void {
        this.checkWait(0);
        if (this.signal.aborted) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.armTimer();
        }, Math.min(this.expiresAt - performance.now(), MAX_TIMER_DELAY_MS));
    }
}
