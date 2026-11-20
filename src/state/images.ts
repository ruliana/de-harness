/**
 * Images in state. A tool puts an image into a slot with `image(...)`; wherever that slot is read by a question
 * (`state.screen`) the model sees the picture. Image values are plain JSON, so they sit anywhere in a slot
 * (`{ screen: image(png) }`, `{ page: { screenshot: image(png) } }`).
 *
 * When the request is built, every image value is replaced by a reference string and listed once in the request's
 * `images`. The reference is a hash of the image bytes, so identical requests stay identical (cassettes replay).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Image } from "../model/types.js";

export type ImageValue = { $image: { format: "png" | "jpg"; base64: string } };

/** Width and height limits of the Jev API, in pixels. An image outside them is rejected, never resized. */
export const IMAGE_LIMITS = { min: 280, max: 1568 } as const;

function detect(bytes: Uint8Array): "png" | "jpg" {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  throw new Error("image: expected PNG or JPEG bytes");
}

/** Pixel size of a PNG, read from its header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * An image value for a state slot, from PNG or JPEG bytes. A PNG outside 280-1568 px per side fails here, with a
 * message that says so, instead of as an API error on the next step.
 */
export function image(bytes: Uint8Array): ImageValue {
  const format = detect(bytes);
  if (format === "png") {
    const { width, height } = pngSize(bytes);
    const { min, max } = IMAGE_LIMITS;
    if (width < min || height < min || width > max || height > max) {
      throw new Error(`image: ${width}x${height} px is outside the ${min}-${max} px per side that Jev accepts`);
    }
  }
  return { $image: { format, base64: Buffer.from(bytes).toString("base64") } };
}

export function imageFile(path: string): ImageValue {
  return image(readFileSync(path));
}

export function isImageValue(value: unknown): value is ImageValue {
  if (typeof value !== "object" || value === null) return false;
  const inner = (value as { $image?: unknown }).$image;
  return typeof inner === "object" && inner !== null && typeof (inner as { base64?: unknown }).base64 === "string";
}

/** The reference string standing for an image in a request. Unlikely to occur in text by accident. */
export function imageRef(value: ImageValue): string {
  return `img-${createHash("sha256").update(value.$image.base64).digest("hex").slice(0, 16)}`;
}

/** Copy of `value` with every image replaced by its reference, and the images found. */
export function extractImages<T>(value: T): { value: T; images: Record<string, Image> } {
  const images: Record<string, Image> = {};
  const walk = (v: unknown): unknown => {
    if (isImageValue(v)) {
      const ref = imageRef(v);
      images[ref] = { format: v.$image.format, base64: v.$image.base64 };
      return ref;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, images };
}
