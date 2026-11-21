// @aphrody/pets: build an OpenPets pet folder (pet.json + spritesheet.webp) from a plan file.
// Bun orchestrates, composites and validates; ffmpeg decodes, scales and encodes WebP because
// Bun.Image (1.4.x) has no crop, composite or raw RGBA input.
import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  defaultPetSprite,
  type UniversalSpriteState,
} from "@open-pets/pet-format/animation";
import { codexV2SpriteLayout } from "@open-pets/pet-format/sprite-layout";
import { validateCodexPetMetadata } from "@open-pets/pet-format/metadata";

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

interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
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

async function decode(path: string, filters = ""): Promise<Rgba> {
  const { width, height } = await new Bun.Image(
    await Bun.file(path).arrayBuffer(),
  ).metadata();
  const vf = filters ? ["-vf", filters] : [];
  const data =
    await $`ffmpeg -loglevel error -i ${path} ${vf} -f rawvideo -pix_fmt rgba -`.arrayBuffer();
  const outWidth = filters ? frameWidth : width;
  const outHeight = filters ? frameHeight : height;
  if (data.byteLength !== outWidth * outHeight * 4)
    throw new Error(`decode ${path}: unexpected size ${data.byteLength}`);
  return { width: outWidth, height: outHeight, data: new Uint8Array(data) };
}

/** Bounding box of pixels with alpha above the threshold. */
function alphaBox(image: Rgba, threshold = 8) {
  let left = image.width,
    top = image.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] > threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) throw new Error("image is fully transparent");
  return { left, top, right, bottom };
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
}

/** Builds `<outDir>/<id>/{pet.json,spritesheet.webp}` and validates it with the OpenPets format rules. */
export async function buildPet(
  planPath: string,
  outDir: string,
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
  const boxes = await Promise.all(
    Object.values(paths).map(async (path) => alphaBox(await decode(path))),
  );
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
  const render = async (name: string, mirror: boolean) => {
    const key = `${name}:${mirror}`;
    const cached = rendered.get(key);
    if (cached) return cached;
    const path = paths[name];
    if (!path) throw new Error(`unknown source ${name}`);
    const filters = [
      `crop=${cropWidth}:${cropHeight}:${crop.left}:${crop.top}`,
      `scale=${scaledWidth}:${scaledHeight}:flags=lanczos`,
      ...(mirror ? ["hflip"] : []),
      `pad=${frameWidth}:${frameHeight}:${padX}:${padY}:color=0x00000000`,
      "format=rgba",
    ].join(",");
    const frame = await decode(path, filters);
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
        await render(frame.source, frame.mirror ?? false),
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
    await render(plan.states.idle[0].source, false),
    codexV2SpriteLayout.neutralPose!.column,
    0,
    0,
    0,
  );
  for (const spare of [9, 10]) {
    for (const [column, frame] of plan.states.idle.entries())
      blit(
        sheet,
        await render(frame.source, false),
        column,
        spare,
        0,
        frame.dy ?? 0,
      );
  }

  const folder = join(outDir, plan.id);
  await mkdir(folder, { recursive: true });
  const raw = join(cacheDir, `${plan.id}.rgba`);
  await Bun.write(raw, sheet);
  const spritesheet = join(folder, "spritesheet.webp");
  await $`ffmpeg -loglevel error -y -f rawvideo -pix_fmt rgba -s ${sheetWidth}x${sheetHeight} -i ${raw} -c:v libwebp -lossless 1 -q:v 100 -frames:v 1 ${spritesheet}`;

  const metadata = {
    id: plan.id,
    displayName: plan.displayName,
    description: plan.description,
    spritesheetPath: "spritesheet.webp",
    spriteVersionNumber: 2,
    ...(plan.gazeAnchor ? { gazeAnchor: plan.gazeAnchor } : {}),
  };
  validateCodexPetMetadata(metadata, plan.id);
  const encoded = await new Bun.Image(
    await Bun.file(spritesheet).arrayBuffer(),
  ).metadata();
  if (encoded.width !== sheetWidth || encoded.height !== sheetHeight) {
    throw new Error(
      `spritesheet is ${encoded.width}x${encoded.height}, expected ${sheetWidth}x${sheetHeight}`,
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
  };
}
