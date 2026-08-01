// Pure unit tests for scripts/check-audit.mjs's decision logic — no
// child_process, no file I/O, no real npm audit call. Fixture `auditJson`
// objects are shaped exactly like real `npm audit --json` output
// (`vulnerabilities: { [packageName]: { via: [...] } }`), and fixture
// baselines are built through the same buildBaselineMap() the real script
// uses to read scripts/dependency-advisory-baseline.json, so these tests
// exercise the actual production decision function, not a re-implementation
// of it. Run via `npm run test:scripts` (also part of the root
// `npm run test`) or directly: `npx vitest run scripts/check-audit.test.mjs`.
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildBaselineMap,
  evaluateFindings,
  extractGatedFindings,
  isDirectInvocation,
} from "./check-audit.mjs";

function baselineWith(...advisories) {
  return buildBaselineMap({ advisories });
}

function auditJsonWith(packageName, via) {
  return { vulnerabilities: { [packageName]: { severity: via.severity, via: [via] } } };
}

describe("extractGatedFindings", () => {
  it("extracts a high-severity advisory object", () => {
    const auditJson = auditJsonWith("left-pad", {
      severity: "high",
      title: "Something bad",
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    });
    const findings = extractGatedFindings(auditJson);
    expect(findings).toEqual([
      {
        advisoryId: "GHSA-aaaa-bbbb-cccc",
        package: "left-pad",
        severity: "high",
        title: "Something bad",
        url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      },
    ]);
  });

  it("skips a plain string via entry (names another affected package, not an advisory)", () => {
    const auditJson = { vulnerabilities: { next: { severity: "high", via: ["postcss"] } } };
    expect(extractGatedFindings(auditJson)).toEqual([]);
  });

  it("excludes moderate/low severity from the gated set entirely", () => {
    const auditJson = {
      vulnerabilities: {
        "pkg-moderate": {
          severity: "moderate",
          via: [{ severity: "moderate", url: "https://github.com/advisories/GHSA-mod0-0000-0000" }],
        },
        "pkg-low": {
          severity: "low",
          via: [{ severity: "low", url: "https://github.com/advisories/GHSA-low0-0000-0000" }],
        },
      },
    };
    expect(extractGatedFindings(auditJson)).toEqual([]);
  });

  it("resolves advisoryId to null (never dropped) when via.url is missing", () => {
    const auditJson = auditJsonWith("mystery-pkg", { severity: "high", title: "No URL given" });
    const findings = extractGatedFindings(auditJson);
    expect(findings).toHaveLength(1);
    expect(findings[0].advisoryId).toBeNull();
    expect(findings[0].package).toBe("mystery-pkg");
    expect(findings[0].severity).toBe("high");
  });

  it("resolves advisoryId to null when via.url ends in a trailing slash (empty final segment)", () => {
    const auditJson = auditJsonWith("mystery-pkg-2", {
      severity: "critical",
      url: "https://github.com/advisories/",
    });
    expect(extractGatedFindings(auditJson)[0].advisoryId).toBeNull();
  });
});

describe("evaluateFindings — the actual pass/fail gate", () => {
  it("(a) accepts a known baselined advisory", () => {
    const baseline = baselineWith({ advisoryId: "GHSA-known-0001", package: "postcss" });
    const findings = [
      {
        advisoryId: "GHSA-known-0001",
        package: "postcss",
        severity: "high",
        title: null,
        url: null,
      },
    ];
    const result = evaluateFindings(findings, baseline);
    expect(result.passed).toBe(true);
    expect(result.unreviewed).toEqual([]);
    expect(result.unidentified).toEqual([]);
    expect(result.reviewed).toHaveLength(1);
  });

  it("(b) fails on a new identified high advisory not in the baseline", () => {
    const baseline = baselineWith({ advisoryId: "GHSA-known-0001", package: "postcss" });
    const findings = [
      {
        advisoryId: "GHSA-new-9999",
        package: "some-other-pkg",
        severity: "high",
        title: null,
        url: null,
      },
    ];
    const result = evaluateFindings(findings, baseline);
    expect(result.passed).toBe(false);
    expect(result.unreviewed).toEqual(findings);
    expect(result.unidentified).toEqual([]);
  });

  it("(c) fails closed on a high advisory with no usable URL/ID, even with an otherwise-matching baseline", () => {
    // Deliberately baselines the *package* under a real advisory ID, to
    // prove an unidentified finding is never accidentally matched against
    // an unrelated baseline entry for the same package.
    const baseline = baselineWith({ advisoryId: "GHSA-known-0001", package: "mystery-pkg" });
    const findings = [
      {
        advisoryId: null,
        package: "mystery-pkg",
        severity: "high",
        title: "No URL given",
        url: null,
      },
    ];
    const result = evaluateFindings(findings, baseline);
    expect(result.passed).toBe(false);
    expect(result.unidentified).toEqual(findings);
    expect(result.unreviewed).toEqual([]);
  });

  it("(d) moderate/low advisories never reach evaluateFindings at all (filtered upstream by extractGatedFindings)", () => {
    const auditJson = {
      vulnerabilities: {
        "pkg-moderate": {
          severity: "moderate",
          via: [{ severity: "moderate", url: "https://github.com/advisories/GHSA-mod0-0000-0000" }],
        },
      },
    };
    const baseline = baselineWith();
    const result = evaluateFindings(extractGatedFindings(auditJson), baseline);
    expect(result.passed).toBe(true);
    expect(result.identified).toEqual([]);
    expect(result.unidentified).toEqual([]);
  });

  it("reports both an unidentified and an unreviewed finding together, still failing", () => {
    const baseline = baselineWith();
    const findings = [
      { advisoryId: null, package: "pkg-a", severity: "critical", title: null, url: null },
      { advisoryId: "GHSA-new-0002", package: "pkg-b", severity: "high", title: null, url: null },
    ];
    const result = evaluateFindings(findings, baseline);
    expect(result.passed).toBe(false);
    expect(result.unidentified).toHaveLength(1);
    expect(result.unreviewed).toHaveLength(1);
  });
});

// v1.0.1: isDirectInvocation() replaced a naive `` `file://${argvPath}` ``
// string template, which never percent-encodes argvPath the way a real
// `file:` URL does — on a checkout path containing a space, #, %, or
// non-ASCII character, that naive comparison was always false, so
// `main()` never ran and `npm run check:audit` silently exited 0 with no
// audit output at all. Each case below builds `moduleUrl` the same way
// Node itself would set `import.meta.url` for that path (via
// `pathToFileURL(...).href`, which does percent-encode), so these tests
// exercise the real encoding behavior the production guard depends on,
// not a re-implementation of it.
describe("isDirectInvocation — encoded-path direct-invocation guard", () => {
  it("detects direct invocation for an ordinary path", () => {
    const argvPath = "/repo/scripts/check-audit.mjs";
    expect(isDirectInvocation(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it("detects direct invocation when the checkout path contains spaces", () => {
    const argvPath = "/Users/keya/Desktop/Mission Thread AI/scripts/check-audit.mjs";
    expect(isDirectInvocation(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it("detects direct invocation when the checkout path contains # and % characters", () => {
    const argvPath = "/repo/mission#thread 100%/scripts/check-audit.mjs";
    expect(isDirectInvocation(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it("detects direct invocation when the checkout path contains non-ASCII characters", () => {
    const argvPath = "/repo/ミッションスレッド/scripts/check-audit.mjs";
    expect(isDirectInvocation(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it("returns false, never throws, when process.argv[1] is absent", () => {
    const moduleUrl = pathToFileURL("/repo/scripts/check-audit.mjs").href;
    expect(() => isDirectInvocation(moduleUrl, undefined)).not.toThrow();
    expect(isDirectInvocation(moduleUrl, undefined)).toBe(false);
  });

  it("returns false for a different module URL — an import, not direct execution", () => {
    const moduleUrl = pathToFileURL("/repo/scripts/check-audit.mjs").href;
    const argvPath = "/repo/scripts/check-audit.test.mjs";
    expect(isDirectInvocation(moduleUrl, argvPath)).toBe(false);
  });

  it("would have silently failed under the old naive `file://${argvPath}` comparison for a spaced path", () => {
    // Documents the exact regression this fix closes: the pre-v1.0.1
    // template-literal comparison never encoded the space, so it never
    // matched a real (encoded) import.meta.url — main() would never have
    // run, and `npm run check:audit` would have exited 0 with no audit
    // output at all.
    const argvPath = "/Users/keya/Desktop/Mission Thread AI/scripts/check-audit.mjs";
    const realModuleUrl = pathToFileURL(argvPath).href;
    const naiveComparison = `file://${argvPath}`;
    expect(realModuleUrl).not.toBe(naiveComparison);
    expect(isDirectInvocation(realModuleUrl, argvPath)).toBe(true);
  });
});
