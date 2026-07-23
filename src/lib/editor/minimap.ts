import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";

// Matches the line-number gutter's own chrome (`cmTheme.ts`'s `.cm-gutters`
// rule) so the minimap reads as part of the same UI rather than a
// bolted-on widget. A plain `baseTheme()`, not a `Compartment`, since it
// only points at a live `--atrium-*` custom property (`cssVars.ts`) and
// never needs explicit reconfiguration on theme switch.
const minimapBaseTheme = EditorView.baseTheme({
  ".cm-minimap-gutter, .cm-minimap-inner": {
    backgroundColor: "var(--atrium-gutter-bg)",
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
