import { extensionOf } from "../util/path";

/** Image formats rendered directly by Atrium's image pane and custom asset protocol. */
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

/** Whether `path` has an extension supported by the image pane. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}
