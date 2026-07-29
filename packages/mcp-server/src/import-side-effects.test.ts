import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_PATH = path.join(PACKAGE_DIR, "src", "test", "probes", "import-probe.mjs");
const SRC_INDEX = path.join(PACKAGE_DIR, "src", "index.ts");
const DIST_INDEX = path.join(PACKAGE_DIR, "dist", "index.js");
const tsxBin = createRequire(import.meta.url).resolve("tsx/cli");

interface ProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runProbe(command: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: PACKAGE_DIR,
      // An intentionally unreachable DATABASE_URL — if importing the
      // module ever attempted a real database query, this child process
      // would hang or error instead of printing its marker block
      // instantly, proving "does not query the database" directly rather
      // than by inference.
      env: { ...process.env, DATABASE_URL: "postgresql://probe:probe@127.0.0.1:19999/probe_db" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, 8000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut: false });
    });
  });
}

function assertCleanImport(result: ProbeResult): void {
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  // No error surface on stderr and no unexpected stdout before the probe's
  // own deliberate marker output — proves the import itself produced zero
  // stdout/stderr and never connected a transport (which would keep the
  // process alive listening on stdin instead of exiting promptly).
  expect(result.stderr).toBe("");
  expect(result.stdout.startsWith("PROBE_MARKER_START\n")).toBe(true);
  expect(result.stdout).toContain("sigint_listeners=0");
  expect(result.stdout).toContain("sigterm_listeners=0");
  expect(result.stdout).toContain("has_createServer=true");
  expect(result.stdout).toContain("has_startStdio=true");
}

describe("package-root import side effects — source entry (src/index.ts, via tsx)", () => {
  it("importing src/index.ts connects no transport, writes nothing to stdout/stderr, registers no SIGINT/SIGTERM handler, and never queries the database", async () => {
    const result = await runProbe(process.execPath, [tsxBin, PROBE_PATH, SRC_INDEX]);
    assertCleanImport(result);
  }, 10_000);
});

describe("package-root import side effects — built entry (dist/index.js, via plain node)", () => {
  it("importing the emitted dist/index.js is equally side-effect-free (skipped if not yet built — run `npm run build --workspace @missionthread/mcp-server` first)", async () => {
    if (!existsSync(DIST_INDEX)) {
      // The ordinary `npm run test`/`test:mcp` command must never require
      // a prior build step — this test provides real coverage of the
      // actual shipped artifact only when one already exists (e.g.
      // during the quality-gate verification pass, after an explicit
      // `npm run build`), and skips cleanly otherwise rather than
      // failing or silently building it as a side effect of testing.
      return;
    }
    const result = await runProbe(process.execPath, [PROBE_PATH, DIST_INDEX]);
    assertCleanImport(result);
  }, 10_000);
});
