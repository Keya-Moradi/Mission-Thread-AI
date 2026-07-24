/**
 * In-memory, process-local rate limiter for AI impact-analysis requests —
 * see docs/THREAT_MODEL.md ("Denial-of-wallet" / "Denial-of-service") and
 * docs/SPEC.md §12 ("An in-memory AI rate limiter is acceptable for MVP,
 * but document its process-local limitation"). Deliberately NOT
 * database-backed: a limiter this cheap and this frequently consulted (on
 * every analysis request) has no business adding a database round-trip or
 * a new table, and MVP has exactly one application instance. A horizontally
 * scaled deployment would need a shared store (Redis, a database row with
 * row-level locking) instead — each process here enforces an independent
 * limit, and a process restart silently clears all counters. Both
 * limitations are accepted for MVP and documented, not engineered around.
 *
 * Identity is the authenticated actor's user ID, never a client IP —
 * IP-based limiting is trivially defeated by NAT/proxies and would
 * conflate multiple real users behind one IP, or one real user across
 * several IPs. The limiter has no knowledge of HTTP requests at all; it is
 * a pure in-memory counter keyed by whatever string the caller supplies.
 */

export const ANALYSIS_RATE_LIMIT_MAX_REQUESTS = 3;
export const ANALYSIS_RATE_LIMIT_WINDOW_SECONDS = 60;

export interface RateLimitAllowedResult {
  allowed: true;
}

export interface RateLimitDeniedResult {
  allowed: false;
  /** Always a positive integer — safe to surface directly to the caller. */
  retryAfterSeconds: number;
}

export type RateLimitCheckResult = RateLimitAllowedResult | RateLimitDeniedResult;

interface WindowState {
  windowStartMs: number;
  count: number;
}

export interface AnalysisRateLimiterOptions {
  /** Injectable so tests never depend on real wall-clock time or sleeps. */
  clock?: () => number;
  maxRequests?: number;
  windowSeconds?: number;
}

/**
 * One fixed-window counter per key. A key's window resets the first time
 * it's checked after the previous window has fully elapsed — there is no
 * background timer; pruning and expiry are both computed lazily from the
 * injected clock at call time, so the limiter has zero timers/intervals to
 * leak or to keep a test process alive.
 */
export class AnalysisRateLimiter {
  private readonly clock: () => number;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, WindowState>();

  constructor(options: AnalysisRateLimiterOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.maxRequests = options.maxRequests ?? ANALYSIS_RATE_LIMIT_MAX_REQUESTS;
    const windowSeconds = options.windowSeconds ?? ANALYSIS_RATE_LIMIT_WINDOW_SECONDS;
    this.windowMs = windowSeconds * 1000;
  }

  /**
   * Checks whether `key` (the authenticated actor's user ID) may proceed,
   * and — only if allowed — atomically consumes one slot in the same call.
   * There is no separate "check" step a caller could race against its own
   * "consume" step. Never touches a database or a provider; purely an
   * in-memory map read/write.
   */
  checkAndConsume(key: string): RateLimitCheckResult {
    const now = this.clock();
    this.pruneExpired(now);

    const existing = this.windows.get(key);
    const startingFreshWindow = !existing || now - existing.windowStartMs >= this.windowMs;
    const windowStartMs = startingFreshWindow ? now : existing.windowStartMs;
    const currentCount = startingFreshWindow ? 0 : existing.count;

    // Checked against currentCount, not existing.count directly — a brand
    // new window (currentCount 0) must still be denied when maxRequests is
    // configured as 0, which the previous unconditional "first ever
    // request always passes" shortcut incorrectly allowed.
    if (currentCount >= this.maxRequests) {
      const windowEndsAtMs = windowStartMs + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((windowEndsAtMs - now) / 1000));
      this.windows.set(key, { windowStartMs, count: currentCount });
      return { allowed: false, retryAfterSeconds };
    }

    this.windows.set(key, { windowStartMs, count: currentCount + 1 });
    return { allowed: true };
  }

  /**
   * Removes every key whose window has fully elapsed — keeps the map
   * bounded by "distinct actors active within the last window," not by
   * every actor who has ever made a request over the process's lifetime.
   * Called at the start of every checkAndConsume(); also exposed directly
   * so a caller (or a test) can force a sweep without waiting for the next
   * request.
   */
  pruneExpired(now: number = this.clock()): void {
    for (const [key, state] of this.windows) {
      if (now - state.windowStartMs >= this.windowMs) {
        this.windows.delete(key);
      }
    }
  }

  /** Test/introspection only — the number of distinct keys currently tracked. */
  size(): number {
    return this.windows.size;
  }

  /**
   * Test-only: clears every tracked window. Production code never calls
   * this — the whole point of the limiter is that state persists for the
   * life of the process. Exists so a test file exercising the shared
   * `defaultAnalysisRateLimiter` across many sequential calls to the same
   * actor (e.g. orchestrator.test.ts, which predates this limiter and
   * doesn't inject its own isolated instance per call) can reset between
   * tests instead of incidentally hitting a real rate limit that has
   * nothing to do with what each of those tests is actually verifying.
   */
  reset(): void {
    this.windows.clear();
  }
}

/**
 * The only limiter instance the production web path ever uses — a single
 * shared, process-wide default so every request across the app is governed
 * by the same counters. Tests and the eval runner must construct their own
 * `new AnalysisRateLimiter(...)` (an isolated instance, usually with an
 * injected clock) rather than sharing or resetting this one, so test runs
 * never interfere with each other or with this module's singleton state.
 */
export const defaultAnalysisRateLimiter = new AnalysisRateLimiter();
