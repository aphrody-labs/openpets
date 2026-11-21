// Pixel pipeline for @aphrody/pets with no native tool: PNG decode/encode in TypeScript on top of
// Bun.Image (which only transcodes), plus crop, premultiplied area scaling, flip and compositing.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  /** Straight (non-premultiplied) 8-bit RGBA, row-major. */
  readonly data: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** Decodes a non-interlaced 8-bit RGB or RGBA PNG; anything else is an error. */
export function decodePng(png: Uint8Array): Rgba {
  if (PNG_SIGNATURE.some((byte, index) => png[index] !== byte))
    throw new Error("decodePng: not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new Error(`decodePng: truncated ${type}`);
    const stored = view.getUint32(offset + 8 + length);
    const actual = crc32(png.subarray(offset + 4, offset + 8 + length));
    if (stored !== actual) throw new Error(`decodePng: bad CRC in ${type}`);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [depth, colorType, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0)
        throw new Error(
          `decodePng: unsupported depth ${depth}, color type ${colorType}, interlace ${interlace}`,
        );
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!width || !height || !channels || idat.length === 0)
    throw new Error("decodePng: missing IHDR or IDAT");

  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height)
    throw new Error(`decodePng: inflated ${raw.length} bytes, expected ${(stride + 1) * height}`);

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const up = y > 0 ? pixels[row - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[row - stride + x - channels]! : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceUp = Math.abs(estimate - up);
          const distanceUpLeft = Math.abs(estimate - upLeft);
          predictor =
            distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
              ? left
              : distanceUp <= distanceUpLeft
                ? up
                : upLeft;
          break;
        }
        default:
          throw new Error(`decodePng: unknown filter ${filter} on row ${y}`);
      }
      pixels[row + x] = (raw[source + x]! + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: pixels };
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data.set(pixels.subarray(index * 3, index * 3 + 3), index * 4);
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encodes straight 8-bit RGBA as a PNG (Sub filter, zlib stream via node:zlib, since Bun.deflateSync emits raw deflate). */
export function encodePng(image: Rgba, level: -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 1): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * 4)
    throw new Error(`encodePng: ${data.length} bytes for ${width}x${height}`);
  const stride = width * 4;
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const target = y * (stride + 1);
    filtered[target] = 1;
    for (let x = 0; x < stride; x++)
      filtered[target + 1 + x] =
        (data[y * stride + x]! - (x >= 4 ? data[y * stride + x - 4]! : 0)) & 0xff;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(filtered, { level })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** Decodes any format Bun.Image reads to RGBA; uses the raw pixel output when this Bun has it. */
export async function decodeImage(bytes: Uint8Array): Promise<Rgba> {
  const image = new Bun.Image(bytes) as Bun.Image & {
    imageData?: () => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  };
  if (typeof image.imageData === "function") {
    const { width, height, data } = await image.imageData();
    return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  }
  return decodePng(await image.png().toBuffer());
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Bounding box of pixels with alpha above the threshold. */
export function alphaBox(image: Rgba, threshold = 8): Box {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3]! > threshold) {
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

/** Per-axis weights of area averaging: destination cell i covers [i*ratio, (i+1)*ratio) of the source. */
function areaWeights(sourceSize: number, targetSize: number) {
  const ratio = sourceSize / targetSize;
  return Array.from({ length: targetSize }, (_, cell) => {
    const start = cell * ratio;
    const end = Math.min(sourceSize, (cell + 1) * ratio);
    const first = Math.floor(start);
    const last = Math.min(sourceSize - 1, Math.ceil(end) - 1);
    const weights = new Float64Array(last - first + 1);
    for (let index = first; index <= last; index++)
      weights[index - first] = (Math.min(end, index + 1) - Math.max(start, index)) / ratio;
    return { first, weights };
  });
}

/**
 * Crops `box` (inclusive) out of `image` and scales it to `width` x `height` by area averaging over
 * the exact source footprint of each target pixel, in premultiplied alpha so transparent pixels
 * contribute no colour (no dark fringes).
 */
export function cropScale(image: Rgba, box: Box, width: number, height: number): Rgba {
  const cropWidth = box.right - box.left + 1;
  const cropHeight = box.bottom - box.top + 1;
  if (box.left < 0 || box.top < 0 || box.right >= image.width || box.bottom >= image.height)
    throw new Error("cropScale: box outside the image");
  const columns = areaWeights(cropWidth, width);
  const lines = areaWeights(cropHeight, height);

  // Horizontal pass: premultiplied float rows of the cropped region.
  const across = new Float32Array(width * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const sourceRow = ((box.top + y) * image.width + box.left) * 4;
    for (let x = 0; x < width; x++) {
      const { first, weights } = columns[x]!;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let k = 0; k < weights.length; k++) {
        const at = sourceRow + (first + k) * 4;
        const weighted = (weights[k]! * image.data[at + 3]!) / 255;
        red += weighted * image.data[at]!;
        green += weighted * image.data[at + 1]!;
        blue += weighted * image.data[at + 2]!;
        alpha += weighted;
      }
      const to = (y * width + x) * 4;
      across[to] = red;
      across[to + 1] = green;
      across[to + 2] = blue;
      across[to + 3] = alpha;
    }
  }

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const { first, weights } = lines[y]!;
    for (let x = 0; x < width; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let k = 0; k < weights.length; k++) {
        const at = ((first + k) * width + x) * 4;
        red += weights[k]! * across[at]!;
        green += weights[k]! * across[at + 1]!;
        blue += weights[k]! * across[at + 2]!;
        alpha += weights[k]! * across[at + 3]!;
      }
      const to = (y * width + x) * 4;
      if (alpha > 0) {
        out[to] = Math.round(red / alpha);
        out[to + 1] = Math.round(green / alpha);
        out[to + 2] = Math.round(blue / alpha);
        out[to + 3] = Math.round(alpha * 255);
      }
    }
  }
  return { width, height, data: out };
}

/** Mirrors horizontally. */
export function flipHorizontal(image: Rgba): Rgba {
  const out = new Uint8Array(image.data.length);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4;
      const to = (y * image.width + (image.width - 1 - x)) * 4;
      out.set(image.data.subarray(from, from + 4), to);
    }
  }
  return { width: image.width, height: image.height, data: out };
}

/** Places `image` on a transparent canvas at (left, top). */
export function pad(image: Rgba, width: number, height: number, left: number, top: number): Rgba {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    const targetY = y + top;
    if (targetY < 0 || targetY >= height) continue;
    for (let x = 0; x < image.width; x++) {
      const targetX = x + left;
      if (targetX < 0 || targetX >= width) continue;
      const from = (y * image.width + x) * 4;
      out.set(image.data.subarray(from, from + 4), (targetY * width + targetX) * 4);
    }
  }
  return { width, height, data: out };
}

export interface EncodeOptions {
  /** Re-encode with the cwebp CLI when it is on PATH and keep the smaller file. Default true. */
  readonly cwebp?: boolean;
}

/**
 * Lossless WebP of an RGBA image: PNG in TypeScript, then Bun.Image at the highest effort (the
 * Aphrody Bun fork honours `effort`; upstream ignores it). The optional `cwebp -lossless -z 9 -exact`
 * pass runs only when cwebp is installed.
 */
export async function encodeWebp(
  image: Rgba,
  options: EncodeOptions = {},
): Promise<{ bytes: Uint8Array; encoder: "bun" | "cwebp" }> {
  const png = encodePng(image);
  const encoded = await new Bun.Image(png)
    .webp({ lossless: true, effort: 6 } as Parameters<Bun.Image["webp"]>[0])
    .toBuffer();
  let best: { bytes: Uint8Array; encoder: "bun" | "cwebp" } = {
    bytes: encoded,
    encoder: "bun",
  };
  const cwebp = options.cwebp === false ? null : Bun.which("cwebp");
  if (!cwebp) return best;
  const scratch = await mkdtemp(join(tmpdir(), "aphrody-pets-"));
  try {
    const input = join(scratch, "sheet.png");
    const output = join(scratch, "sheet.webp");
    await Bun.write(input, png);
    const run = Bun.spawnSync([cwebp, "-quiet", "-lossless", "-z", "9", "-exact", input, "-o", output]);
    if (run.exitCode === 0) {
      const optimized = new Uint8Array(await Bun.file(output).arrayBuffer());
      if (optimized.length < best.bytes.length) best = { bytes: optimized, encoder: "cwebp" };
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return best;
}
