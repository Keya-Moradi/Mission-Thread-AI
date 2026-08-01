#!/usr/bin/env node
// Dependency-advisory gate: `npm run check:audit` (and CI's "Dependency
// vulnerability scan" step). Passing means "no new, unreviewed high or
// critical advisory" — never "zero vulnerabilities." Every currently
// accepted finding is recorded, by exact (advisoryId, package) identity,
// in scripts/dependency-advisory-baseline.json (see
// docs/DEPENDENCY_ADVISORIES.md for the human-readable rendering and full
// reasoning). A finding not in that baseline fails this check; a finding
// that IS in the baseline is reported but does not fail it.
//
// Fails closed on an unidentifiable advisory: a high/critical `via` object
// with no usable `url` (and therefore no derivable advisory ID) can never
// be silently skipped or matched against the baseline — there is no real
// identity to check it against, so it always fails the gate with full safe
// context (package, severity, title) for a human to investigate directly.
// See docs/DECISIONS.md, "Dependency-advisory gate: fail closed on an
// unidentified advisory."
//
// Deliberately never runs `npm audit fix --force` or mutates
// package.json/package-lock.json itself — this script only reads the
// output of `npm audit --json` and compares it against the reviewed
// baseline.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = join(ROOT_DIR, "scripts", "dependency-advisory-baseline.json");
export const GATED_SEVERITIES = new Set(["high", "critical"]);

/** Pure: builds the (advisoryId, package) lookup map from already-parsed
 * baseline JSON — no file I/O, so tests can construct fixture baselines
 * directly. */
export function buildBaselineMap(parsedBaseline) {
  const key = (entry) => `${entry.advisoryId}::${entry.package}`;
  return new Map(parsedBaseline.advisories.map((entry) => [key(entry), entry]));
}

function loadBaseline() {
  const raw = readFileSync(BASELINE_PATH, "utf8");
  return buildBaselineMap(JSON.parse(raw));
}

function runNpmAudit() {
  try {
    const output = execFileSync("npm", ["audit", "--json"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(output);
  } catch (error) {
    // `npm audit` exits non-zero whenever any vulnerability is found — that
    // is expected and not itself a failure here; its JSON is still on
    // stdout. Only a genuinely unparsable/missing result is an error.
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        throw new Error(`Failed to parse "npm audit --json" output: ${error.stdout}`);
      }
    }
    throw error;
  }
}

/** Pure: extracts one row per genuine advisory (an object `via` entry — a
 * plain string `via` entry just names another affected package and is not
 * itself an advisory) at or above the gated severity, across every
 * reported package. `advisoryId` is `null` — never silently dropped —
 * when `via.url` yields no usable, non-empty identity. */
export function extractGatedFindings(auditJson) {
  const findings = [];
  for (const [packageName, vulnerability] of Object.entries(auditJson.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === "string") continue;
      if (!GATED_SEVERITIES.has(via.severity)) continue;
      const advisoryId = via.url?.split("/").pop()?.trim() || null;
      findings.push({
        advisoryId,
        package: packageName,
        severity: via.severity,
        title: via.title ?? null,
        url: via.url ?? null,
      });
    }
  }
  return findings;
}

/** Pure: the actual pass/fail decision, given already-extracted findings
 * and an already-built baseline map. Separated from `main()` so it's
 * directly unit-testable with fixture data — no child_process, no file
 * I/O, no npm invocation. An unidentified finding (`advisoryId === null`)
 * can never be matched against `baseline` (there is no real identity to
 * look up) and always counts against `passed`, independent of the
 * unreviewed-identified-advisory check. */
export function evaluateFindings(findings, baseline) {
  const identified = findings.filter((f) => f.advisoryId !== null);
  const unidentified = findings.filter((f) => f.advisoryId === null);
  const unreviewed = identified.filter((f) => !baseline.has(`${f.advisoryId}::${f.package}`));
  const reviewed = identified.filter((f) => baseline.has(`${f.advisoryId}::${f.package}`));

  return {
    identified,
    unidentified,
    unreviewed,
    reviewed,
    passed: unidentified.length === 0 && unreviewed.length === 0,
  };
}

function report(result) {
  const { identified, unidentified, unreviewed, reviewed } = result;
  console.log(
    `Dependency advisory gate: ${identified.length + unidentified.length} high/critical advisory reference(s) found.`,
  );
  for (const finding of identified) {
    const status = unreviewed.includes(finding) ? "NOT REVIEWED" : "reviewed, accepted";
    console.log(`  [${status}] ${finding.advisoryId} (${finding.package}, ${finding.severity})`);
  }
  for (const finding of unidentified) {
    const titlePart = finding.title ? ` — ${finding.title}` : "";
    console.log(
      `  [UNIDENTIFIED] ${finding.package} (${finding.severity})${titlePart} — no usable advisory URL/ID`,
    );
  }

  if (unidentified.length > 0) {
    console.error(
      `\nFAIL: ${unidentified.length} high/critical advisory object(s) have no usable ` +
        "advisory URL/ID and cannot be safely matched against the reviewed baseline in " +
        "scripts/dependency-advisory-baseline.json — an unidentified advisory can never be " +
        "accepted through it. Run a plain `npm audit` (not `--json`) to investigate the " +
        "package(s) named above directly; once the real advisory identity is known, add a " +
        "reviewed entry (see docs/DEPENDENCY_ADVISORIES.md) or resolve it.",
    );
  }
  if (unreviewed.length > 0) {
    console.error(
      `\nFAIL: ${unreviewed.length} high/critical advisory reference(s) are not in ` +
        "scripts/dependency-advisory-baseline.json. Either add a reviewed entry there " +
        "(with dependency path, reachability, fix status, deferral reason, and review " +
        "date — see docs/DEPENDENCY_ADVISORIES.md) or resolve the advisory (a compatible " +
        "`npm audit fix`, never `--force`, if one is available).",
    );
  }
  if (unidentified.length === 0 && unreviewed.length === 0) {
    console.log(
      "\nPASS: no new, unreviewed high/critical advisory. " +
        "(This does not mean zero vulnerabilities — see docs/DEPENDENCY_ADVISORIES.md " +
        `for every currently accepted, reviewed finding — ${reviewed.length} this run.)`,
    );
  }
}

function main() {
  const baseline = loadBaseline();
  const auditJson = runNpmAudit();
  const findings = extractGatedFindings(auditJson);
  const result = evaluateFindings(findings, baseline);
  report(result);
  process.exitCode = result.passed ? 0 : 1;
}

/** Pure: true when this module was the process's direct entry point
 * (`node check-audit.mjs` / `npm run check:audit`), false when it was only
 * imported (e.g. by a test). `import.meta.url` is always a proper,
 * percent-encoded `file:` URL; `argvPath` is a raw filesystem path from
 * `process.argv[1]` and must be converted with `pathToFileURL()` before
 * comparison — a naive `` `file://${argvPath}` `` template does not
 * percent-encode a space, `#`, `%`, or non-ASCII character the way a real
 * `file:` URL does, so on a checkout path containing any of those this
 * comparison would always be false, `main()` would never run, and
 * `npm run check:audit` would silently exit 0 with no audit output at all
 * — a "PASS" that never actually checked anything. See docs/DECISIONS.md,
 * "v1.0.1 — encoded-path direct-invocation guard fix." Returns `false`,
 * never throws, when `argvPath` is absent (e.g. under some non-standard
 * process launchers). */
export function isDirectInvocation(moduleUrl, argvPath) {
  if (!argvPath) return false;
  return moduleUrl === pathToFileURL(argvPath).href;
}

// Only run as a script when invoked directly — not when a test imports
// this module's exported pure functions, which must never shell out to
// npm or read the baseline file as a side effect of import alone.
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main();
}
