import { describe, expect, it } from "vitest";
import {
  AnalysisRateLimiter,
  ANALYSIS_RATE_LIMIT_MAX_REQUESTS,
  ANALYSIS_RATE_LIMIT_WINDOW_SECONDS,
  defaultAnalysisRateLimiter,
} from "./analysis-rate-limiter";

/** A controllable, injectable clock — no real-time sleeps anywhere in this
 * file, per the Phase 6 authorization's explicit instruction. */
function makeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("AnalysisRateLimiter — production defaults", () => {
  it("MVP defaults are 3 requests per 60 seconds", () => {
    expect(ANALYSIS_RATE_LIMIT_MAX_REQUESTS).toBe(3);
    expect(ANALYSIS_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it("defaultAnalysisRateLimiter uses the documented production defaults and cannot be reconfigured through its public API", () => {
    // No constructor arguments, no setter — the only way to get a
    // different threshold is to construct a separate instance (used only
    // by tests/evals), never to mutate this shared one. Verified here by
    // simply confirming its behavior matches the documented constants.
    const limiter = defaultAnalysisRateLimiter;
    const key = `prod-defaults-probe-${Date.now()}`;
    for (let i = 0; i < ANALYSIS_RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(limiter.checkAndConsume(key).allowed).toBe(true);
    }
    expect(limiter.checkAndConsume(key).allowed).toBe(false);
  });
});

describe("AnalysisRateLimiter — fixed-window behavior", () => {
  it("[first N requests pass] exactly ANALYSIS_RATE_LIMIT_MAX_REQUESTS requests are allowed in one window", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({ clock: clock.now });
    for (let i = 0; i < ANALYSIS_RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(limiter.checkAndConsume("user-1").allowed).toBe(true);
    }
  });

  it("[N+1th request denied] the next request inside the same window is denied with a positive retryAfterSeconds", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({ clock: clock.now });
    for (let i = 0; i < ANALYSIS_RATE_LIMIT_MAX_REQUESTS; i++) {
      limiter.checkAndConsume("user-1");
    }
    const result = limiter.checkAndConsume("user-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
  });

  it("[window reset] allowance resets once the window has fully elapsed", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({ clock: clock.now });
    for (let i = 0; i < ANALYSIS_RATE_LIMIT_MAX_REQUESTS; i++) {
      limiter.checkAndConsume("user-1");
    }
    expect(limiter.checkAndConsume("user-1").allowed).toBe(false);

    clock.advance(ANALYSIS_RATE_LIMIT_WINDOW_SECONDS * 1000);
    expect(limiter.checkAndConsume("user-1").allowed).toBe(true);
  });

  it("[not yet reset] one millisecond before the window elapses, the request is still denied", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({ clock: clock.now });
    for (let i = 0; i < ANALYSIS_RATE_LIMIT_MAX_REQUESTS; i++) {
      limiter.checkAndConsume("user-1");
    }
    clock.advance(ANALYSIS_RATE_LIMIT_WINDOW_SECONDS * 1000 - 1);
    expect(limiter.checkAndConsume("user-1").allowed).toBe(false);
  });

  it("[independent actors] two different keys have fully independent allowances", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({ clock: clock.now });
    for (let i = 0; i < ANALYSIS_RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(limiter.checkAndConsume("user-A").allowed).toBe(true);
    }
    expect(limiter.checkAndConsume("user-A").allowed).toBe(false);
    // user-B is untouched by user-A's exhausted window.
    expect(limiter.checkAndConsume("user-B").allowed).toBe(true);
  });

  it("[maxRequests: 0 denies even the very first request] a zero-configured limiter never allows any request through, including the first one ever made for a key", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 0,
      windowSeconds: 60,
    });
    const result = limiter.checkAndConsume("brand-new-key");
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("[custom thresholds] an isolated instance can use a different limit/window for tests or evals without affecting the default", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 1,
      windowSeconds: 10,
    });
    expect(limiter.checkAndConsume("user-1").allowed).toBe(true);
    expect(limiter.checkAndConsume("user-1").allowed).toBe(false);
    expect(defaultAnalysisRateLimiter.checkAndConsume(`unaffected-${Date.now()}`).allowed).toBe(
      true,
    );
  });
});

describe("AnalysisRateLimiter — pruning", () => {
  it("[pruning removes expired keys] the internal map shrinks back down once a key's window has elapsed", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({ clock: clock.now });
    limiter.checkAndConsume("user-1");
    limiter.checkAndConsume("user-2");
    limiter.checkAndConsume("user-3");
    expect(limiter.size()).toBe(3);

    clock.advance(ANALYSIS_RATE_LIMIT_WINDOW_SECONDS * 1000);
    // A fresh check for a brand-new key triggers the lazy prune sweep,
    // which should drop all three now-expired entries before adding the
    // new one.
    limiter.checkAndConsume("user-4");
    expect(limiter.size()).toBe(1);
  });

  it("[bounded, not unbounded] pruneExpired() can be invoked directly without waiting for the next request", () => {
    const clock = makeClock();
    const limiter = new AnalysisRateLimiter({ clock: clock.now });
    limiter.checkAndConsume("user-1");
    expect(limiter.size()).toBe(1);
    clock.advance(ANALYSIS_RATE_LIMIT_WINDOW_SECONDS * 1000);
    limiter.pruneExpired();
    expect(limiter.size()).toBe(0);
  });
});
