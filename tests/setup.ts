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
 * jsdom implements no Web Animations API at all — `Element.prototype.animate`
 * and `.getAnimations` are simply absent, so any component rendered under a
 * test that uses Svelte's `animate:` directive (`EditorPanel.svelte`'s
 * `animate:flip` on the tab strip, its first use anywhere in `src/`) throws
 * `element.getAnimations is not a function`/`element.animate is not a
 * function` the moment a keyed `{#each}` reconciliation touches an animated
 * node — which happens on any tab add/remove/reorder, not just a drag, so
 * this reaches far past `EditorPanel.svelte`'s own tests into any
 * `App.svelte`-level test that renders a real (non-stubbed) tab strip.
 * jsdom has no layout engine either, so the animation's actual visual
 * progression is never something a test could assert on regardless — this
 * polyfill exists purely to let Svelte's internal animation state machine
 * (`transitions.js`) run to completion without crashing: `getAnimations`
 * reports no in-progress animations (so `fix()` always proceeds), and
 * `animate()` returns a minimal `Animation`-shaped object whose `onfinish`
 * fires on the next microtask, close enough to real timing (a real
 * zero-duration dummy animation resolves next-microtask too) for Svelte's
 * own dummy-delay-then-real-animation sequencing to progress correctly.
 */
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = function (): Animation[] {
    return [];
  };
}

if (typeof Element.prototype.animate !== "function") {
  Element.prototype.animate = function (): Animation {
    const animation = {
      onfinish: null as (() => void) | null,
      oncancel: null as (() => void) | null,
      currentTime: 0,
      playState: "running" as AnimationPlayState,
      effect: null,
      finished: Promise.resolve() as unknown as Animation["finished"],
      cancel(): void {
        animation.playState = "idle";
      },
      finish(): void {
        animation.playState = "finished";
        animation.onfinish?.();
      },
      play(): void {},
      pause(): void {},
      reverse(): void {},
    } as unknown as Animation;
    queueMicrotask(() => (animation as unknown as { finish(): void }).finish());
    return animation;
  };
}
