import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 6 correction pass: proves evals/run-live.ts's own HTTP-call ceiling
// structurally, complementing the runtime proof in openai-provider.test.ts
// (buildOpenAiClientOptions -> maxRetries: 0, one generateImpactAnalysis()
// call -> exactly one responses.create() call) and
// orchestrator-provider-spend.test.ts (the orchestrator's own 2-attempt
// cap). Together: fixed 6 fictional fixtures, no retry loop in run-live.ts
// itself, and no SDK-level retry inside the provider it calls = at most 6
// real HTTP requests for one `npm run eval:live` invocation. A static
// source scan, not a runtime test — evals/ has no test runner wired up,
// and adding one is out of scope for this narrowly-scoped correction pass;
// this file lives in packages/core (which already does have a test runner)
// and reads evals/run-live.ts's actual source directly, so a future edit
// to that file that reintroduces a retry loop or changes the fixture count
// fails this test immediately.
const RUN_LIVE_PATH = join(__dirname, "..", "..", "..", "..", "evals", "run-live.ts");

describe("evals/run-live.ts — HTTP-call ceiling (Phase 6 correction)", () => {
  const source = readFileSync(RUN_LIVE_PATH, "utf8");

  it("[fixed six-fixture cap] LIVE_EVAL_FIXTURES has exactly 6 entries, and MAX_LIVE_PROVIDER_CALLS is derived from its length rather than a second, independently maintained number", () => {
    const fixtureEntries = source.match(/\{\s*\n?\s*id:\s*"/g) ?? [];
    expect(fixtureEntries.length).toBe(6);
    expect(source).toContain("const MAX_LIVE_PROVIDER_CALLS = LIVE_EVAL_FIXTURES.length;");
  });

  it("[no retry construct around the provider call] the fixture loop calls generateImpactAnalysis() exactly once per iteration, with no while/retry/attempt wrapper", () => {
    expect(source).toContain("for (const fixture of LIVE_EVAL_FIXTURES)");
    expect(source).not.toMatch(/\bwhile\s*\(/);
    // Exactly one *awaited call site* — deliberately not a bare substring
    // count, since the file's own doc comment above also mentions
    // "generateImpactAnalysis()" in prose describing what the script does.
    expect(source.match(/await provider\.generateImpactAnalysis\(/g)?.length).toBe(1);
  });

  it("[opt-in check runs before any provider construction] requireLiveOptIn(process.env) is the first statement in main(), before createProviderFromEnv()", () => {
    const mainBody = source.slice(source.indexOf("async function main"));
    const optInIndex = mainBody.indexOf("requireLiveOptIn(process.env)");
    const providerIndex = mainBody.indexOf("createProviderFromEnv()");
    expect(optInIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(-1);
    expect(optInIndex).toBeLessThan(providerIndex);
  });

  it("[exact-value opt-in checks, never truthy] every required environment variable is compared with strict equality", () => {
    expect(source).toContain('env.AI_MODE !== "live"');
    expect(source).toContain('env.RUN_LIVE_EVALS !== "true"');
    expect(source).toContain("!env.OPENAI_API_KEY");
  });
});
