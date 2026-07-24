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
