import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  alphaBox,
  crc32,
  cropScale,
  decodeImage,
  decodePng,
  encodePng,
  flipHorizontal,
  pad,
  type Rgba,
} from "../src/image.ts";

function noise(width: number, height: number): Rgba {
  const data = new Uint8Array(width * height * 4);
  let state = 12345;
  for (let index = 0; index < data.length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data[index] = state >>> 24;
  }
  // WebP lossless drops the colour of fully transparent pixels, so keep the fixture canonical.
  for (let pixel = 0; pixel < width * height; pixel++)
    if (data[pixel * 4 + 3] === 0) data.fill(0, pixel * 4, pixel * 4 + 3);
  return { width, height, data };
}

/** Builds a PNG by hand with a chosen filter per row, to exercise every decoder branch. */
function filteredPng(
  image: Rgba,
  channels: 3 | 4,
  filterFor: (row: number) => number,
  header: Partial<{ depth: number; colorType: number; interlace: number }> = {},
): Uint8Array {
  const stride = image.width * channels;
  const rows = Array.from({ length: image.height }, (_, y) =>
    Uint8Array.from({ length: stride }, (_, x) => {
      const pixel = Math.floor(x / channels);
      return image.data[(y * image.width + pixel) * 4 + (x % channels)]!;
    }),
  );
  const raw = new Uint8Array((stride + 1) * image.height);
  rows.forEach((row, y) => {
    const filter = filterFor(y);
    raw[y * (stride + 1)] = filter;
    row.forEach((value, x) => {
      const left = x >= channels ? row[x - channels]! : 0;
      const up = y > 0 ? rows[y - 1]![x]! : 0;
      const upLeft = y > 0 && x >= channels ? rows[y - 1]![x - channels]! : 0;
      const estimate = left + up - upLeft;
      const paeth = [left, up, upLeft].sort(
        (a, b) => Math.abs(estimate - a) - Math.abs(estimate - b),
      )[0]!;
      // Ties must resolve left, up, upLeft; sort is stable so the order above holds.
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter]!;
      raw[y * (stride + 1) + 1 + x] = (value - predictor) & 0xff;
    });
  });
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  ihdr.set(
    [
      header.depth ?? 8,
      header.colorType ?? (channels === 4 ? 6 : 2),
      0,
      0,
      header.interlace ?? 0,
    ],
    8,
  );
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", deflateSync(raw)),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("crc32", () => {
  test("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("PNG codec", () => {
  test("encode then decode is lossless", () => {
    const image = noise(37, 23);
    const decoded = decodePng(encodePng(image));
    expect(decoded.width).toBe(37);
    expect(decoded.height).toBe(23);
    expect(decoded.data).toEqual(image.data);
  });

  test("Bun.Image reads our PNG and its PNG decodes back to the same pixels", async () => {
    const image = noise(64, 48);
    const png = encodePng(image);
    expect(await new Bun.Image(png).metadata()).toMatchObject({
      width: 64,
      height: 48,
      format: "png",
    });
    expect((await decodeImage(png)).data).toEqual(image.data);
    const webp = await new Bun.Image(png).webp({ lossless: true }).toBuffer();
    expect((await decodeImage(webp)).data).toEqual(image.data);
  });

  test("decodes each of the five filter types", () => {
    const image = noise(9, 5);
    for (const filter of [0, 1, 2, 3, 4]) {
      const decoded = decodePng(filteredPng(image, 4, () => filter));
      expect(decoded.data).toEqual(image.data);
    }
    expect(decodePng(filteredPng(image, 4, (row) => row % 5)).data).toEqual(image.data);
  });

  test("decodes RGB with opaque alpha", () => {
    const image = noise(7, 6);
    const decoded = decodePng(filteredPng(image, 3, (row) => row % 5));
    for (let pixel = 0; pixel < 42; pixel++) {
      expect(decoded.data.subarray(pixel * 4, pixel * 4 + 3)).toEqual(
        image.data.subarray(pixel * 4, pixel * 4 + 3),
      );
      expect(decoded.data[pixel * 4 + 3]).toBe(255);
    }
  });

  test("rejects other depths, color types, interlacing, corrupt data", () => {
    const image = noise(4, 4);
    expect(() => decodePng(filteredPng(image, 4, () => 0, { depth: 16 }))).toThrow(/unsupported/);
    expect(() => decodePng(filteredPng(image, 3, () => 0, { colorType: 3 }))).toThrow(/unsupported/);
    expect(() => decodePng(filteredPng(image, 4, () => 0, { interlace: 1 }))).toThrow(/unsupported/);
    expect(() => decodePng(new Uint8Array(20))).toThrow(/not a PNG/);
    const corrupt = encodePng(image);
    corrupt[corrupt.length - 20] ^= 0xff;
    expect(() => decodePng(corrupt)).toThrow(/CRC|inflate|expected|incorrect/i);
  });
});

describe("cropScale", () => {
  const strip = (values: number[], alpha = 255): Rgba => ({
    width: values.length,
    height: 1,
    data: Uint8Array.from(values.flatMap((value) => [value, value, value, alpha])),
  });
  const everything = (image: Rgba) => ({ left: 0, top: 0, right: image.width - 1, bottom: image.height - 1 });

  test("integer ratio averages exactly", () => {
    const gradient = strip([0, 40, 80, 120, 160, 200, 240, 255]);
    const scaled = cropScale(gradient, everything(gradient), 4, 1);
    expect([0, 1, 2, 3].map((x) => scaled.data[x * 4])).toEqual([20, 100, 180, 248]);
  });

  test("fractional ratio weights the exact source footprint", () => {
    // Target cell 0 covers source [0, 1.5): 1 * 0 + 0.5 * 90, over 1.5 = 30; cell 1 covers [1.5, 3): 0.5 * 90 + 1 * 180, over 1.5 = 150.
    const gradient = strip([0, 90, 180]);
    const scaled = cropScale(gradient, everything(gradient), 2, 1);
    expect([scaled.data[0], scaled.data[4]]).toEqual([30, 150]);
  });

  test("a linear gradient stays linear and monotonic on a large downscale", () => {
    const wide = strip(Array.from({ length: 1000 }, (_, x) => Math.round((x / 999) * 255)));
    const scaled = cropScale(wide, everything(wide), 10, 1);
    const values = Array.from({ length: 10 }, (_, x) => scaled.data[x * 4]!);
    for (let x = 1; x < 10; x++) expect(values[x]!).toBeGreaterThan(values[x - 1]!);
    expect(values[0]).toBeLessThan(15);
    expect(values[9]).toBeGreaterThan(240);
  });

  test("premultiplied averaging leaves no dark fringe at transparent edges", () => {
    const edge: Rgba = {
      width: 2,
      height: 1,
      data: Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0]),
    };
    const scaled = cropScale(edge, everything(edge), 1, 1);
    expect([...scaled.data]).toEqual([255, 255, 255, 128]);
  });

  test("crops before scaling and rejects boxes outside the image", () => {
    const gradient = strip([10, 20, 30, 40]);
    const scaled = cropScale(gradient, { left: 1, top: 0, right: 2, bottom: 0 }, 1, 1);
    expect(scaled.data[0]).toBe(25);
    expect(() => cropScale(gradient, { left: 0, top: 0, right: 4, bottom: 0 }, 1, 1)).toThrow();
  });

  test("alphaBox, flip and pad", () => {
    const image = noise(5, 4);
    image.data.fill(0);
    image.data.set([1, 2, 3, 255], (1 * 5 + 3) * 4);
    expect(alphaBox(image)).toEqual({ left: 3, top: 1, right: 3, bottom: 1 });
    expect(flipHorizontal(image).data.subarray((1 * 5 + 1) * 4, (1 * 5 + 1) * 4 + 4)).toEqual(
      Uint8Array.from([1, 2, 3, 255]),
    );
    const padded = pad(image, 8, 6, 2, 1);
    expect(padded.data.subarray((2 * 8 + 5) * 4, (2 * 8 + 5) * 4 + 4)).toEqual(
      Uint8Array.from([1, 2, 3, 255]),
    );
    expect(() => alphaBox({ width: 1, height: 1, data: new Uint8Array(4) })).toThrow(/transparent/);
  });
});
