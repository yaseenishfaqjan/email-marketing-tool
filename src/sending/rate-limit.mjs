/**
 * Token bucket, in process.
 *
 * SES throttles hard at the account send rate and returns a Throttling error
 * for everything over it. Being throttled mid-broadcast is far more expensive
 * than sending slightly slower, so the bucket is set to ~80% of the real quota
 * (see SES_MAX_SEND_RATE) and the worker waits rather than pushing.
 *
 * In process is correct for ONE send worker, which is what Phase 1 runs. The
 * moment a second worker starts, each gets its own bucket and the account
 * limit is exceeded by the number of workers — at that point this moves to a
 * Redis bucket. The constructor argument makes that swap a one-file change.
 */

export class TokenBucket {
  /**
   * @param {number} ratePerSecond
   * @param {number} [burst]  defaults to one second of capacity
   */
  constructor(ratePerSecond, burst = null) {
    if (!(ratePerSecond > 0)) throw new Error('ratePerSecond must be positive');
    this.rate = ratePerSecond;
    this.capacity = burst ?? Math.max(1, Math.ceil(ratePerSecond));
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  #refill(now) {
    const elapsed = (now - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  /** Milliseconds to wait before one token is available. 0 if it already is. */
  delayFor(now = Date.now()) {
    this.#refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }

  /** Waits if necessary, then consumes one token. */
  async take() {
    for (;;) {
      const wait = this.delayFor();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
