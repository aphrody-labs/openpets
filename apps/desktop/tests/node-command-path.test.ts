import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

const userDataPath = realpathSync(mkdtempSync(join(tmpdir(), "openpets-node-command-path-")));
const nodeDirectory = join(userDataPath, "node");
const nodePath = join(nodeDirectory, "node.exe");
const rawNodePath = `${nodeDirectory}${sep}..${sep}node${sep}node.exe`;
mkdirSync(nodeDirectory, { recursive: true });
writeFileSync(nodePath, "node", "utf8");
chmodSync(nodePath, 0o700);
writeFileSync(join(userDataPath, "openpets-state.json"), JSON.stringify({ version: 1, preferences: { nodeCommandPath: rawNodePath } }), "utf8");

const electronMock = {
  app: { getVersion: () => "4.1.0", getPath: () => userDataPath, isReady: () => true },
  net: {},
  powerMonitor: { on: () => {}, getSystemIdleTime: () => 0 },
  screen: { on: () => {}, getAllDisplays: () => [] },
  shell: { openPath: async () => "" },
};

// Resolved at run time: the desktop test build has no Bun type declarations.
const bunTestSpecifier = "bun:test";
const { mock } = (await import(bunTestSpecifier)) as {
  readonly mock: { module(specifier: string, factory: () => Record<string, unknown>): void };
};
mock.module("electron", () => ({ ...electronMock, default: electronMock }));

try {
  const { getAppStateSnapshot, initializeAppState, releaseStartupInstallLock } = await import("../src/app-state.js");
  try {
    initializeAppState();
    assert.equal(getAppStateSnapshot().preferences.nodeCommandPath, rawNodePath);
    const persisted = JSON.parse(readFileSync(join(userDataPath, "openpets-state.json"), "utf8")) as { preferences?: { nodeCommandPath?: unknown } };
    assert.equal(persisted.preferences?.nodeCommandPath, rawNodePath);
  } finally {
    releaseStartupInstallLock();
  }
} finally {
  rmSync(userDataPath, { recursive: true, force: true });
}

console.error("Node command paths are resolved for validation and preserved in their safe configured form.");
