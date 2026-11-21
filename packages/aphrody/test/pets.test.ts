import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCodexPetMetadata } from "@open-pets/pet-format/metadata";
import { decodeImage, type Rgba } from "../src/image.ts";
import { buildPet, sheetHeight, sheetWidth, type BuildResult } from "../src/pets.ts";

const plan = join(import.meta.dir, "..", "pets", "byron-love.json");
const referencePath = join(import.meta.dir, "fixtures", "byron-love.ffmpeg.webp");

/** Channel delta of premultiplied RGBA (colour over black) on pixels either sheet shows. */
function visibleDiff(a: Rgba, b: Rgba) {
  let max = 0;
  let sum = 0;
  let channels = 0;
  let visible = 0;
  for (let pixel = 0; pixel < a.width * a.height; pixel++) {
    const alphaA = a.data[pixel * 4 + 3]!;
    const alphaB = b.data[pixel * 4 + 3]!;
    if (alphaA === 0 && alphaB === 0) continue;
    visible++;
    for (let channel = 0; channel < 4; channel++) {
      const at = pixel * 4 + channel;
      const valueA = channel === 3 ? alphaA : (a.data[at]! * alphaA) / 255;
      const valueB = channel === 3 ? alphaB : (b.data[at]! * alphaB) / 255;
      const delta = Math.abs(valueA - valueB);
      if (delta > max) max = delta;
      sum += delta;
      channels++;
    }
  }
  return { max, mean: sum / channels, visible };
}

describe("build pets/byron-love.json", () => {
  let out = "";
  let built: BuildResult;
  let sheet: Rgba;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "aphrody-pets-test-"));
    built = await buildPet(plan, out, { cwebp: false });
    sheet = await decodeImage(new Uint8Array(await Bun.file(built.spritesheet).arrayBuffer()));
  }, 60_000);
  afterAll(() => rm(out, { recursive: true, force: true }));

  test("writes a 1536x2288 lossless WebP with 57 frames", async () => {
    expect([sheetWidth, sheetHeight]).toEqual([1536, 2288]);
    expect(await new Bun.Image(await Bun.file(built.spritesheet).arrayBuffer()).metadata()).toMatchObject({
      width: 1536,
      height: 2288,
      format: "webp",
    });
    expect(built.frames).toBe(57);
    expect(built.encoder).toBe("bun");
    expect(built.bytes).toBeGreaterThan(50_000);
    expect(built.bytes).toBeLessThan(500_000);
  });

  test("pet.json passes validateCodexPetMetadata", async () => {
    const metadata = await Bun.file(join(built.folder, "pet.json")).json();
    expect(() => validateCodexPetMetadata(metadata, "byron-love")).not.toThrow();
    expect(metadata).toMatchObject({ id: "byron-love", spritesheetPath: "spritesheet.webp", spriteVersionNumber: 2 });
  });

  test("visible pixels stay close to the ffmpeg lanczos reference", async () => {
    const reference = await decodeImage(new Uint8Array(await Bun.file(referencePath).arrayBuffer()));
    expect([reference.width, reference.height]).toEqual([sheet.width, sheet.height]);
    const { max, mean, visible } = visibleDiff(sheet, reference);
    console.log(`diff vs ffmpeg: max channel delta ${max.toFixed(2)}, mean ${mean.toFixed(3)}, visible pixels ${visible}`);
    expect(visible).toBeGreaterThan(100_000);
    expect(mean).toBeLessThan(8);
  });

  test("an optional cwebp re-encode never grows the file", async () => {
    const again = await buildPet(plan, out);
    expect(again.bytes).toBeLessThanOrEqual(built.bytes);
    expect(["bun", "cwebp"]).toContain(again.encoder);
  }, 60_000);
});
