/**
 * Token bucket for spoken AI replies: `perMinute` tokens refill continuously,
 * up to `burst`. Time is injected so tests are exact.
 */
export class TokenBucket {
    #capacity: number;
    #perMs: number;
    #tokens: number;
    #at: number;

    constructor(perMinute: number, burst = 2, now = Date.now()) {
        this.#capacity = burst;
        this.#perMs = perMinute / 60_000;
        this.#tokens = burst;
        this.#at = now;
    }

    setRate(perMinute: number, now = Date.now()): void {
        this.#refill(now);
        this.#perMs = perMinute / 60_000;
    }

    #refill(now: number): void {
        const elapsed = Math.max(0, now - this.#at);
        this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#perMs);
        this.#at = now;
    }

    available(now = Date.now()): number {
        this.#refill(now);
        return this.#tokens;
    }

    tryTake(now = Date.now()): boolean {
        this.#refill(now);
        if (this.#tokens < 1) return false;
        this.#tokens -= 1;
        return true;
    }

    /** Give a token back (a draft that failed before speaking should not cost a slot). */
    refund(now = Date.now()): void {
        this.#refill(now);
        this.#tokens = Math.min(this.#capacity, this.#tokens + 1);
    }

    /** ms until the next token is available; 0 when one is ready now. */
    msUntilNext(now = Date.now()): number {
        this.#refill(now);
        if (this.#tokens >= 1) return 0;
        return Math.ceil((1 - this.#tokens) / this.#perMs);
    }
}
