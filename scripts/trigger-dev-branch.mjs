#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Solider.uz change: some hosts (seen on WSL) advertise AAAA records for
// Trigger.dev's S2 streamstore (a.s2.dev) but have no working IPv6 route.
// Node's Happy Eyeballs connection racing then lets the dead IPv6 candidates
// stall a request long enough that even the working IPv4 address times out,
// surfacing as "S2Error: Max attempts (3) exhausted: Connection failed:
// ETIMEDOUT" on every agent-long run. See
// scripts/fix-ipv6-happy-eyeballs.cjs for the full explanation; this just
// preloads it into the spawned Trigger CLI (and any Node process it forks)
// via NODE_OPTIONS, inherited by spawn() below like the rest of process.env.
// A no-op on hosts where IPv6 actually works.
const ipv6FixPath = fileURLToPath(
  new URL("./fix-ipv6-happy-eyeballs.cjs", import.meta.url),
);
process.env.NODE_OPTIONS = [
  `--require ${JSON.stringify(ipv6FixPath)}`,
  process.env.NODE_OPTIONS,
]
  .filter(Boolean)
  .join(" ");

const sanitizeBranchName = (value) => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  return normalized || "local";
};

const configuredBranch = process.env.TRIGGER_DEV_BRANCH?.trim();
const triggerArgs = ["dev", "start"];

if (configuredBranch) {
  const triggerBranch = sanitizeBranchName(configuredBranch);
  triggerArgs.push("--branch", triggerBranch);
  console.log(
    `[trigger-dev] using explicit Trigger.dev branch: ${triggerBranch}`,
  );
} else {
  console.log("[trigger-dev] using default Trigger.dev branch");
}

const child = spawn("trigger", [...triggerArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(
    `[trigger-dev] failed to start Trigger.dev CLI: ${error.message}`,
  );
  process.exit(1);
});
