import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";

// Matches the line-number gutter's own chrome (`cmTheme.ts`'s `.cm-gutters`
// rule) so the minimap reads as part of the same UI rather than a
// bolted-on widget. A plain `baseTheme()`, not a `Compartment`, since it
// only points at a live `--atrium-*` custom property (`cssVars.ts`) and
// never needs explicit reconfiguration on theme switch.
//
// No positioning override here: the gutter uses the package's own default
// in-flow, sticky flex-sibling layout, permanently reserving width from the
// editable column. That tradeoff is intentional — floating it as an
// absolutely-positioned overlay instead hovered over and obscured editor
// text, which is worse. Don't reintroduce `position: absolute` here.
const minimapBaseTheme = EditorView.baseTheme({
  ".cm-minimap-gutter, .cm-minimap-inner": {
    backgroundColor: "var(--atrium-gutter-bg)",
  },
  ".cm-minimap-overlay-container": {
    userSelect: "none",
    WebkitUserSelect: "none",
  },
});

function createMinimapDom(): { dom: HTMLElement } {
  return { dom: document.createElement("div") };
}

/** Returns whether the scroll container has content extending beyond its viewport. */
export function isScrollable(scrollDOM: HTMLElement): boolean {
  // A zero dimension means the view has not been laid out yet (as in jsdom).
  // Keep the minimap enabled until the browser provides real geometry.
  return scrollDOM.clientHeight === 0 || scrollDOM.scrollHeight === 0 || scrollDOM.scrollHeight > scrollDOM.clientHeight;
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
