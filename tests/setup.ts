import { JSDOM } from "jsdom";

/**
 * Node 22.4+ defines its own experimental `localStorage`/`sessionStorage`
 * globals as getters that return `undefined` unless the process was started
 * with `--localstorage-file`. vitest's jsdom environment assigns jsdom's
 * window properties onto `globalThis` but leaves those pre-existing built-in
 * accessors in place, so on any Node newer than CI's pinned 22.x the built-in
 * getters shadow jsdom's real `Storage` objects and every test touching
 * `localStorage` fails with "Cannot read properties of undefined". jsdom's
 * `Storage` can't be constructed directly (illegal constructor), so this mints
 * a throwaway window purely to borrow a genuine pair of `Storage` instances —
 * real quota/serialization semantics, not a `Map` stand-in. The `url` must be
 * a non-opaque origin or jsdom refuses to expose storage at all.
 *
 * Redefining is unconditional rather than guarded on the current value: on
 * CI's Node the globals are already jsdom's and swapping in an equivalent pair
 * is harmless, which keeps both Node versions on exactly one code path.
 */
const storageDonor = new JSDOM("", { url: "http://localhost:3000" });

for (const key of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, key, {
    value: storageDonor.window[key],
    configurable: true,
    writable: true,
  });
}

/**
 * jsdom doesn't implement `CSS.escape` (its `CSS` global has no `escape`
 * member at all), unlike every real browser engine Tauri actually runs on.
 * `FileTree.svelte`'s roving-tabindex focus restoration builds an attribute
 * selector with it, so component tests need this polyfill (the standard
 * CSSOM algorithm, mirroring the native behavior it stands in for) or every
 * such focus call throws under vitest.
 */
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
  const escape = (value: string): string => {
    const string = String(value);
    const length = string.length;
    let result = "";
    let index = -1;
    let codeUnit: number;
    const firstCodeUnit = string.charCodeAt(0);
    while (++index < length) {
      codeUnit = string.charCodeAt(index);
      if (codeUnit === 0x0000) {
        result += "�";
        continue;
      }
      if (
        (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
        codeUnit === 0x007f ||
        (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (index === 1 &&
          codeUnit >= 0x0030 &&
          codeUnit <= 0x0039 &&
          firstCodeUnit === 0x002d)
      ) {
        result += `\\${codeUnit.toString(16)} `;
        continue;
      }
      if (
        index === 0 &&
        length === 1 &&
        codeUnit === 0x002d
      ) {
        result += `\\${string.charAt(index)}`;
        continue;
      }
      if (
        codeUnit >= 0x0080 ||
        codeUnit === 0x002d ||
        codeUnit === 0x005f ||
        (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
        (codeUnit >= 0x0061 && codeUnit <= 0x007a)
      ) {
        result += string.charAt(index);
        continue;
      }
      result += `\\${string.charAt(index)}`;
    }
    return result;
  };
  globalThis.CSS = { ...(globalThis.CSS ?? {}), escape } as typeof CSS;
}
