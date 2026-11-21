import { build } from "esbuild";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { builtInPetWardrobe, builtInPetOutfitFileName, builtInPetOutfitsDirectory } from "@open-pets/pet-format/builtin-hoodie-cat";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const vipsRoot = resolve(dirname(require.resolve("wasm-vips")), "..");

// Emscripten bridges worker_threads messages only when `globalThis.postMessage` is missing.
// Bun defines it in workers, which skips the bridge and deadlocks every pthread that libvips
// starts. Dropping that guard is a no-op under Node and Electron, where it is always undefined.
async function copyVipsNodeEntry() {
  const guard = "globalThis.postMessage||(";
  const source = await readFile(resolve(vipsRoot, "lib", "vips-node.mjs"), "utf8");
  if (!source.includes(guard)) throw new Error("wasm-vips vips-node.mjs no longer contains the worker message bridge guard.");
  await writeFile(resolve(root, "dist", "decoder", "vips-node.mjs"), source.replace(guard, "("));
}
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist", "media"), { recursive: true });
await mkdir(resolve(root, "dist", "decoder"), { recursive: true });
await Promise.all([
  build({
    entryPoints: [resolve(root, "src/host/scene-worker.ts")],
    outfile: resolve(root, "dist/scene-worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
  }),
  copyVipsNodeEntry(),
  ...[
    "vips.wasm",
    "vips-heif.wasm",
    "vips-jxl.wasm",
    "vips-resvg.wasm",
  ].map((file) =>
    cp(resolve(vipsRoot, "lib", file), resolve(root, "dist", "decoder", file)),
  ),
  ...["LICENSE", "THIRD-PARTY-NOTICES.md"].map((file) =>
    cp(resolve(vipsRoot, file), resolve(root, "dist", "decoder", file)),
  ),
]);
await cp(
  resolve(root, "../desktop/assets/default-pet-spritesheet.webp"),
  resolve(root, "dist/media/default-pet-spritesheet.webp"),
);
await mkdir(resolve(root, "dist/media", builtInPetOutfitsDirectory), { recursive: true });
await Promise.all(builtInPetWardrobe.outfits.map(async (outfit) => {
  const fileName = builtInPetOutfitFileName(outfit.id);
  if (!fileName) throw new Error(`Missing bundled outfit path for ${outfit.id}.`);
  await cp(resolve(root, "../desktop/assets", fileName), resolve(root, "dist/media", fileName));
}));
await Promise.all([
  build({
    entryPoints: [resolve(root, "src/host/validation-worker.ts")],
    outfile: resolve(root, "dist/validation-worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
  }),
  build({
    entryPoints: [resolve(root, "src/host/package-validation.ts")],
    outfile: resolve(root, "dist/package-validation.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
  }),
  build({
    entryPoints: [resolve(root, "src/extension.ts")],
    outfile: resolve(root, "dist/extension.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
  }),
  build({
    entryPoints: [resolve(root, "src/webview/main.tsx")],
    outfile: resolve(root, "dist/webview/main.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
  }),
]);
// A missing renderer stylesheet is a broken build, not an empty-style fallback.
await access(resolve(root, "dist/webview/main.css"));
