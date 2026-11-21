import { readFileSync } from "node:fs";
import { image, type ImageValue } from "./images.js";

/** An image value from a PNG or JPEG file. Node only. */
export function imageFile(path: string): ImageValue {
  return image(readFileSync(path));
}
