import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? join(process.cwd(), "apps/desktop");
const electronMock = { app: { getAppPath: () => desktopRoot } };

// Resolved at run time: the desktop test build has no Bun type declarations.
const bunTestSpecifier = "bun:test";
const { mock } = (await import(bunTestSpecifier)) as {
  readonly mock: { module(specifier: string, factory: () => Record<string, unknown>): void };
};
mock.module("electron", () => ({ ...electronMock, default: electronMock }));

test("catalog falls back to the fixture and resolves pets", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      throw new Error("catalog unavailable");
    };

    const fixtureFallback = await import("../src/catalog.js");
    const fixtureState = await fixtureFallback.getCatalogUiState();
    assert.equal(fixtureState.source, "fixture");
    assert.ok(fixtureState.pets.length > 0);
    assert.equal(fixtureState.total, fixtureState.pets.length);
    assert.equal(fixtureState.pets.every((pet) => pet.original === undefined && pet.featured === undefined), true);
    assert.equal((await fixtureFallback.getCatalogPet("snoopy")).id, "snoopy");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
