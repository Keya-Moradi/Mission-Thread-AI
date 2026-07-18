#!/usr/bin/env node
// Runs the given command with ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true
// (and, if --scope is given, MISSIONTHREAD_SEED_SCOPE) set for that child
// process only — never exported into the parent shell, never written to a
// file. Implemented as a Node child_process spawn rather than shell
// "VAR=value cmd" syntax (which cmd.exe on Windows doesn't support), so the
// deliberately-named destructive npm scripts that use this work the same
// on every platform without adding a cross-env-style dependency.
import { spawn } from "node:child_process";

const rawArgs = process.argv.slice(2);
let scope;
const commandArgs = [];
for (const arg of rawArgs) {
  if (arg.startsWith("--scope=")) {
    scope = arg.slice("--scope=".length);
  } else {
    commandArgs.push(arg);
  }
}

const [command, ...args] = commandArgs;
if (!command) {
  console.error(
    "Usage: node scripts/with-destructive-auth.mjs [--scope=<dev|test|github-actions>] <command> [args...]",
  );
  process.exit(1);
}

const env = { ...process.env, ALLOW_DESTRUCTIVE_DATABASE_OPERATION: "true" };
if (scope) {
  env.MISSIONTHREAD_SEED_SCOPE = scope;
}

const child = spawn(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
