// @aphrody/pets: build an OpenPets pet folder (pet.json + spritesheet.webp) from a plan file.
// Everything runs in Bun: Bun.Image transcodes, src/image.ts decodes PNG, crops, scales and composites.
// Optional: when `cwebp` is on PATH the sheet is also re-encoded with `cwebp -lossless -z 9 -exact` and the smaller file is kept (--no-cwebp skips it).
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  defaultPetSprite,
  type UniversalSpriteState,
} from "@open-pets/pet-format/animation";
import { codexV2SpriteLayout } from "@open-pets/pet-format/sprite-layout";
import { validateCodexPetMetadata } from "@open-pets/pet-format/metadata";

import {
  alphaBox,
  cropScale,
  decodeImage,
  encodeWebp,
  flipHorizontal,
  pad,
  type EncodeOptions,
  type Rgba,
} from "./image.ts";

const { frameWidth, frameHeight, columns, rows } = codexV2SpriteLayout;
export const sheetWidth = frameWidth * columns; // 1536
export const sheetHeight = frameHeight * rows; // 2288

/** One cell: which source image, and how far to shift it (px, in the 192x208 frame). */
export interface PlanFrame {
  readonly source: string;
  readonly dx?: number;
  readonly dy?: number;
  readonly mirror?: boolean;
}

export interface PetPlan {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Named images: a URL or a path relative to the plan file. */
  readonly sources: Readonly<Record<string, string>>;
  /** Frames per state; each state's count must match the OpenPets layout (idle 6, running-right 8, ...). */
  readonly states: Readonly<Record<UniversalSpriteState, readonly PlanFrame[]>>;
  /** Margin (px) kept under the feet and on the sides of every frame. */
  readonly margin?: number;
  readonly gazeAnchor?: { readonly x: number; readonly y: number };
}

async function fetchSource(
  source: string,
  planDir: string,
  cacheDir: string,
): Promise<string> {
  if (!/^https?:\/\//.test(source)) return resolve(planDir, source);
  const target = join(cacheDir, basename(new URL(source).pathname));
  if (!(await Bun.file(target).exists())) {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(`fetch ${source}: HTTP ${response.status}`);
    await Bun.write(target, response);
  }
  return target;
}

function blit(
  sheet: Uint8Array,
  frame: Rgba,
  column: number,
  row: number,
  dx: number,
  dy: number,
) {
  for (let y = 0; y < frame.height; y++) {
    const targetY = row * frameHeight + y + dy;
    if (targetY < row * frameHeight || targetY >= (row + 1) * frameHeight)
      continue;
    for (let x = 0; x < frame.width; x++) {
      const targetX = column * frameWidth + x + dx;
      if (targetX < column * frameWidth || targetX >= (column + 1) * frameWidth)
        continue;
      const from = (y * frame.width + x) * 4;
      const to = (targetY * sheetWidth + targetX) * 4;
      sheet.set(frame.data.subarray(from, from + 4), to);
    }
  }
}

export interface BuildResult {
  readonly folder: string;
  readonly spritesheet: string;
  readonly bytes: number;
  readonly frames: number;
  readonly encoder: "bun" | "cwebp";
}

/** Builds `<outDir>/<id>/{pet.json,spritesheet.webp}` and validates it with the OpenPets format rules. */
export async function buildPet(
  planPath: string,
  outDir: string,
  options: EncodeOptions = {},
): Promise<BuildResult> {
  const plan = (await Bun.file(planPath).json()) as PetPlan;
  const planDir = dirname(resolve(planPath));
  const cacheDir = join(outDir, ".cache");
  await mkdir(cacheDir, { recursive: true });
  const margin = plan.margin ?? 6;

  for (const [state, definition] of Object.entries(defaultPetSprite.states)) {
    const frames = plan.states[state as UniversalSpriteState];
    if (!frames || frames.length !== definition.frames) {
      throw new Error(
        `state ${state} needs ${definition.frames} frames, plan has ${frames?.length ?? 0}`,
      );
    }
  }

  const paths: Record<string, string> = {};
  for (const [name, source] of Object.entries(plan.sources))
    paths[name] = await fetchSource(source, planDir, cacheDir);

  // One crop box for every source keeps scale and feet position identical across frames.
  const decoded = new Map<string, Rgba>();
  for (const [name, path] of Object.entries(paths))
    decoded.set(name, await decodeImage(new Uint8Array(await Bun.file(path).arrayBuffer())));
  const boxes = [...decoded.values()].map((image) => alphaBox(image));
  const crop = boxes.reduce((box, next) => ({
    left: Math.min(box.left, next.left),
    top: Math.min(box.top, next.top),
    right: Math.max(box.right, next.right),
    bottom: Math.max(box.bottom, next.bottom),
  }));
  const cropWidth = crop.right - crop.left + 1;
  const cropHeight = crop.bottom - crop.top + 1;
  // Reserve room above the head for the highest upward offset (jumps) so no frame clips.
  const headroom =
    2 +
    Math.max(
      0,
      ...Object.values(plan.states)
        .flat()
        .map((frame) => -(frame.dy ?? 0)),
    );
  const scale = Math.min(
    (frameWidth - 2 * margin) / cropWidth,
    (frameHeight - margin - headroom) / cropHeight,
  );
  const scaledWidth = Math.max(1, Math.round(cropWidth * scale));
  const scaledHeight = Math.max(1, Math.round(cropHeight * scale));
  const padX = Math.floor((frameWidth - scaledWidth) / 2);
  const padY = frameHeight - margin - scaledHeight;

  const rendered = new Map<string, Rgba>();
  const render = (name: string, mirror: boolean) => {
    const key = `${name}:${mirror}`;
    const cached = rendered.get(key);
    if (cached) return cached;
    const source = decoded.get(name);
    if (!source) throw new Error(`unknown source ${name}`);
    const scaled = cropScale(source, crop, scaledWidth, scaledHeight);
    const frame = pad(
      mirror ? flipHorizontal(scaled) : scaled,
      frameWidth,
      frameHeight,
      padX,
      padY,
    );
    rendered.set(key, frame);
    return frame;
  };

  const sheet = new Uint8Array(sheetWidth * sheetHeight * 4);
  let count = 0;
  for (const [state, frames] of Object.entries(plan.states)) {
    const row = defaultPetSprite.states[state as UniversalSpriteState].row;
    for (const [column, frame] of frames.entries()) {
      blit(
        sheet,
        render(frame.source, frame.mirror ?? false),
        column,
        row,
        frame.dx ?? 0,
        frame.dy ?? 0,
      );
      count++;
    }
  }
  // Layout v2 shows column 6 of row 0 as the neutral pose; rows 9-10 are spare and repeat idle.
  blit(
    sheet,
    render(plan.states.idle[0].source, false),
    codexV2SpriteLayout.neutralPose!.column,
    0,
    0,
    0,
  );
  for (const spare of [9, 10]) {
    for (const [column, frame] of plan.states.idle.entries())
      blit(
        sheet,
        render(frame.source, false),
        column,
        spare,
        0,
        frame.dy ?? 0,
      );
  }

  const folder = join(outDir, plan.id);
  await mkdir(folder, { recursive: true });
  const spritesheet = join(folder, "spritesheet.webp");
  const encoded = await encodeWebp(
    { width: sheetWidth, height: sheetHeight, data: sheet },
    options,
  );
  await Bun.write(spritesheet, encoded.bytes);

  const metadata = {
    id: plan.id,
    displayName: plan.displayName,
    description: plan.description,
    spritesheetPath: "spritesheet.webp",
    spriteVersionNumber: 2,
    ...(plan.gazeAnchor ? { gazeAnchor: plan.gazeAnchor } : {}),
  };
  validateCodexPetMetadata(metadata, plan.id);
  const written = await new Bun.Image(
    await Bun.file(spritesheet).arrayBuffer(),
  ).metadata();
  if (written.width !== sheetWidth || written.height !== sheetHeight) {
    throw new Error(
      `spritesheet is ${written.width}x${written.height}, expected ${sheetWidth}x${sheetHeight}`,
    );
  }
  await Bun.write(
    join(folder, "pet.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  return {
    folder,
    spritesheet,
    bytes: Bun.file(spritesheet).size,
    frames: count,
    encoder: encoded.encoder,
  };
}
