#!/usr/bin/env bun
// Reproducible CI on the fleet builder: SSH to fr1, check out origin/main in ~/ci/openpets,
// run `bun run install:release` and `bun run test`, print per-step timings, exit with the first failing step's code.
//   bun scripts/ci/fr1-test.ts [--host fr1] [--dir ~/ci/openpets] [--ref origin/main]
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "fr1" },
    dir: { type: "string", default: "~/ci/openpets" },
    ref: { type: "string", default: "origin/main" },
    remote: { type: "string", default: "origin" },
  },
});
const { host, dir, ref, remote } = values as Record<"host" | "dir" | "ref" | "remote", string>;

interface Step {
  readonly name: string;
  readonly command: string;
}

// `$HOME` expands on the remote side; a leading `~/` in --dir is rewritten for the same reason.
const remoteDir = dir.replace(/^~(?=\/|$)/, "$HOME");
const branch = ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
const steps: readonly Step[] = [
  {
    name: "checkout",
    command: `cd "${remoteDir}" && git fetch --prune ${remote} ${branch} && git checkout --force --detach ${ref} && git log -1 --format='checked out %h %s'`,
  },
  { name: "install:release", command: `cd "${remoteDir}" && bun run install:release` },
  { name: "test", command: `cd "${remoteDir}" && bun run test` },
];

const timings: { name: string; seconds: number; exitCode: number }[] = [];
const started = performance.now();
let exitCode = 0;
for (const step of steps) {
  console.log(`\n== ${host}: ${step.name}`);
  const stepStart = performance.now();
  const ssh = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", host, `bash -lc 'set -euo pipefail; ${step.command.replaceAll("'", `'\\''`)}'`],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const code = await ssh.exited;
  timings.push({ name: step.name, seconds: (performance.now() - stepStart) / 1000, exitCode: code });
  if (code !== 0) {
    exitCode = code;
    break;
  }
}

console.log(`\n== ${host} summary (${ref})`);
for (const { name, seconds, exitCode: code } of timings)
  console.log(`${name.padEnd(16)} ${seconds.toFixed(1).padStart(7)} s  exit ${code}`);
console.log(`${"total".padEnd(16)} ${((performance.now() - started) / 1000).toFixed(1).padStart(7)} s  exit ${exitCode}`);
process.exit(exitCode);
