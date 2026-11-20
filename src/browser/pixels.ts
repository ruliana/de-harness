/**
 * Comparing two screenshots, to tell a page that changed from a pointer that only lit up an element. A just-enough PNG reader
 * (8-bit grey, RGB or RGBA, no interlacing, which is what Chromium writes) and a count of the pixels that differ outside some regions.
 */
import { inflateSync } from "node:zlib";

/** A rectangle in viewport pixels. */
export type Region = { left: number; top: number; right: number; bottom: number };

type Raster = { width: number; height: number; channels: number; data: Uint8Array };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** The pixels of a PNG, or null when it is a kind this reader does not handle (the caller then compares the bytes). */
export function decodePng(bytes: Uint8Array): Raster | null {
  const buf = Buffer.from(bytes);
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colour = buf[25]!;
  const channels = CHANNELS[colour];
  if (depth !== 8 || channels === undefined || buf[28] !== 0) return null;
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") parts.push(buf.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = y * stride;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[row + x - channels]! : 0;
      const up = y > 0 ? data[row - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? data[row - stride + x - channels]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) return null;
      data[row + x] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

/**
 * True when two PNGs (base64) differ only inside `ignore`: every pixel outside those regions is the same. Identical bytes are the
 * same screenshot without looking at a pixel; pictures this reader cannot decode, or of different sizes, are compared as bytes.
 */
export function sameOutside(a: string, b: string, ignore: readonly Region[]): boolean {
  if (a === b) return true;
  if (ignore.length === 0) return false;
  const pa = decodePng(Buffer.from(a, "base64"));
  const pb = decodePng(Buffer.from(b, "base64"));
  if (!pa || !pb || pa.width !== pb.width || pa.height !== pb.height || pa.channels !== pb.channels) return false;
  const { width, height, channels } = pa;
  const inside = (x: number, y: number) => ignore.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      let differs = false;
      for (let c = 0; c < channels; c++) if (pa.data[at + c] !== pb.data[at + c]) differs = true;
      if (differs && !inside(x, y)) return false;
    }
  }
  return true;
}
