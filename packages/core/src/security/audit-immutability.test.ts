import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static source-scan regression test: proves no application code anywhere
// in this repository ever calls prisma.auditEvent.update/.delete/.upsert —
// the append-only guarantee this project makes for AuditEvent is enforced
// by "no such call exists," not by a runtime guard that could itself be
// bypassed or forgotten in a new code path. See docs/THREAT_MODEL.md,
// "Audit tampering." Intentionally a plain source scan, not a Prisma
// middleware/extension check — a new call site would fail this test the
// moment it's written, before it ever runs against a real database.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCAN_ROOTS = [
  join(REPO_ROOT, "packages", "core", "src"),
  join(REPO_ROOT, "apps", "web", "src"),
];
const FORBIDDEN_PATTERNS = [
  /auditEvent\s*\.\s*update/,
  /auditEvent\s*\.\s*delete/,
  /auditEvent\s*\.\s*upsert/,
];

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("audit immutability — static source scan", () => {
  it("[no update/delete/upsert on auditEvent anywhere in application source]", () => {
    const violations: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        const content = readFileSync(file, "utf8");
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            violations.push(`${file}: matches ${pattern}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("[sanity: the scan itself actually finds real code] auditEvent.create appears somewhere in the scanned source", () => {
    let found = false;
    for (const root of SCAN_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        if (/auditEvent\s*\.\s*create/.test(readFileSync(file, "utf8"))) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });
});
