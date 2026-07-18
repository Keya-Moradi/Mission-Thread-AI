#!/usr/bin/env node
// Runs the given command with ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true set
// for that child process only — never exported into the parent shell, never
// written to a file. Implemented as a Node child_process spawn rather than
// shell "VAR=value cmd" syntax (which cmd.exe on Windows doesn't support),
// so the deliberately-named destructive npm scripts that use this work the
// same on every platform without adding a cross-env-style dependency.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/with-destructive-auth.mjs <command> [args...]");
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, ALLOW_DESTRUCTIVE_DATABASE_OPERATION: "true" },
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
