import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";

// Matches the line-number gutter's own chrome (`cmTheme.ts`'s `.cm-gutters`
// rule) so the minimap reads as part of the same UI rather than a
// bolted-on widget. A plain `baseTheme()`, not a `Compartment`, since it
// only points at a live `--atrium-*` custom property (`cssVars.ts`) and
// never needs explicit reconfiguration on theme switch.
//
// The package's own bundled theme lays `.cm-minimap-gutter` out as a
// `position: sticky` flex sibling of `.cm-content`, which both reserves
// permanent width from the code column and stretches to the full editor
// height. These rules pull it out of flow instead: `position: absolute`
// anchors it to the nearest positioned ancestor (`.cm-editor`, made
// `position: relative` below) rather than participating in `.cm-content`'s
// flex sizing, and floating-panel chrome (border/radius/shadow) matches
// `ContextMenu.svelte`'s so it reads as a panel rather than a sidebar.
//
// The package registers its own layout rules via `EditorView.theme()`, which
// carries the same CSS specificity as our `baseTheme()` rules below (both
// are a single class-prefixed selector) and happens to mount after ours, so
// an un-flagged declaration here would silently lose the cascade to the
// package's `position: sticky`/`top: 0`/`right: 0`. `!important` makes the
// override deterministic regardless of extension mount order.
const minimapBaseTheme = EditorView.baseTheme({
  "&": {
    position: "relative",
  },
  ".cm-minimap-gutter, .cm-minimap-inner": {
    backgroundColor: "var(--atrium-gutter-bg)",
  },
  ".cm-minimap-gutter": {
    position: "absolute !important",
    top: "8px !important",
    right: "8px !important",
    border: "1px solid var(--atrium-border) !important",
    borderRadius: "6px !important",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3) !important",
    overflow: "hidden !important",
    zIndex: "10 !important",
  },
});

function createMinimapDom(): { dom: HTMLElement } {
  return { dom: document.createElement("div") };
}

/** Returns the minimap extension when `enabled`, or `[]` to omit it entirely. */
export function minimapExtension(enabled: boolean): Extension[] {
  if (!enabled) return [];
  return [
    showMinimap.of({
      create: createMinimapDom,
      displayText: "characters",
      showOverlay: "always",
    }),
    minimapBaseTheme,
  ];
}
