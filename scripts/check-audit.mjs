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
// Deliberately never runs `npm audit fix --force` or mutates
// package.json/package-lock.json itself — this script only reads the
// output of `npm audit --json` and compares it against the reviewed
// baseline.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = join(ROOT_DIR, "scripts", "dependency-advisory-baseline.json");
const GATED_SEVERITIES = new Set(["high", "critical"]);

function loadBaseline() {
  const raw = readFileSync(BASELINE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const key = (entry) => `${entry.advisoryId}::${entry.package}`;
  return new Map(parsed.advisories.map((entry) => [key(entry), entry]));
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

/** Extracts one row per genuine advisory (an object `via` entry — a plain
 * string `via` entry just names another affected package and is not itself
 * an advisory) at or above the gated severity, across every reported
 * package. */
function extractGatedFindings(auditJson) {
  const findings = [];
  for (const [packageName, vulnerability] of Object.entries(auditJson.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === "string") continue;
      if (!GATED_SEVERITIES.has(via.severity)) continue;
      const advisoryId = via.url?.split("/").pop();
      if (!advisoryId) continue;
      findings.push({
        advisoryId,
        package: packageName,
        severity: via.severity,
        title: via.title,
        url: via.url,
      });
    }
  }
  return findings;
}

function main() {
  const baseline = loadBaseline();
  const auditJson = runNpmAudit();
  const findings = extractGatedFindings(auditJson);

  const unreviewed = findings.filter(
    (finding) => !baseline.has(`${finding.advisoryId}::${finding.package}`),
  );

  console.log(
    `Dependency advisory gate: ${findings.length} high/critical advisory reference(s) found.`,
  );
  for (const finding of findings) {
    const status = baseline.has(`${finding.advisoryId}::${finding.package}`)
      ? "reviewed, accepted"
      : "NOT REVIEWED";
    console.log(`  [${status}] ${finding.advisoryId} (${finding.package}, ${finding.severity})`);
  }

  if (unreviewed.length > 0) {
    console.error(
      `\nFAIL: ${unreviewed.length} high/critical advisory reference(s) are not in ` +
        "scripts/dependency-advisory-baseline.json. Either add a reviewed entry there " +
        "(with dependency path, reachability, fix status, deferral reason, and review " +
        "date — see docs/DEPENDENCY_ADVISORIES.md) or resolve the advisory (a compatible " +
        "`npm audit fix`, never `--force`, if one is available).",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nPASS: no new, unreviewed high/critical advisory. " +
      "(This does not mean zero vulnerabilities — see docs/DEPENDENCY_ADVISORIES.md " +
      "for every currently accepted, reviewed finding.)",
  );
}

main();
