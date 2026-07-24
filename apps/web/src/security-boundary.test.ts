import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 6 §10 authorization/mutation security regression tests, apps/web
// side — static source scans, not runtime checks, so a new violation fails
// immediately at test time rather than requiring a specific request to
// exercise it. See docs/THREAT_MODEL.md.

const APP_DIR = join(__dirname, "app");

const MUTATION_FUNCTION_NAMES = [
  "recordProgramEvent",
  "runImpactAnalysis",
  "recordMitigationDecision",
  "applyApprovedChanges",
];

function collectFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...collectFiles(fullPath, predicate));
      continue;
    }
    if (predicate(entry)) results.push(fullPath);
  }
  return results;
}

describe("no GET page performs a mutation", () => {
  it('[page.tsx never imports a packages/core mutation function] every mutation is reached only through a "use server" actions.ts file, never directly from a page component', () => {
    const pageFiles = collectFiles(APP_DIR, (name) => name === "page.tsx");
    expect(pageFiles.length).toBeGreaterThan(5); // sanity: the scan found real pages

    const violations: string[] = [];
    for (const file of pageFiles) {
      const content = readFileSync(file, "utf8");
      for (const fn of MUTATION_FUNCTION_NAMES) {
        // A word-boundary match against the imported-name position only —
        // deliberately not just `.includes(fn)`, since some mutation names
        // are substrings of unrelated identifiers used defensively (e.g. a
        // page rendering the *result type* of an analysis, which is fine).
        const importPattern = new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from`);
        if (importPattern.test(content)) {
          violations.push(`${file} imports ${fn} directly`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("server actions derive the actor only from the authenticated session", () => {
  it("[actions.ts never reads a client-supplied actorId/userId/role field] every actor identity comes from auth(), never from FormData", () => {
    const actionFiles = collectFiles(APP_DIR, (name) => name === "actions.ts");
    expect(actionFiles.length).toBeGreaterThan(2); // sanity: the scan found real action files

    const forbiddenFormDataKeys = ["actorId", "actorUserId", "userId", "role"];
    const violations: string[] = [];
    for (const file of actionFiles) {
      const content = readFileSync(file, "utf8");
      expect(content).toContain('"use server"');
      for (const key of forbiddenFormDataKeys) {
        const pattern = new RegExp(`formData\\.get\\(\\s*["']${key}["']\\s*\\)`);
        if (pattern.test(content)) {
          violations.push(`${file} reads formData.get("${key}")`);
        }
      }
      // Every action file that performs a mutation must call auth() itself
      // to obtain the session it derives the actor from — files that don't
      // touch a mutation function at all (none currently) would have no
      // reason to, so this only asserts for files that actually call one.
      const callsAMutation = MUTATION_FUNCTION_NAMES.some((fn) => content.includes(`${fn}(`));
      if (callsAMutation) {
        expect(content).toContain("auth()");
      }
    }
    expect(violations).toEqual([]);
  });
});
