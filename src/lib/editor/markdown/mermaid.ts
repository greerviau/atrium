import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/**
 * Memoized dynamic import of the `mermaid` package. Mermaid's own bundle is
 * large (D3 plus per-diagram-type renderers), so it is fetched only the
 * first time a document actually containing a mermaid block is decorated,
 * never as part of the app's main bundle.
 */
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

function importMermaid(): Promise<typeof import("mermaid")> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid");
  }
  return mermaidModulePromise;
}

/**
 * Reads Atrium's current `--atrium-*` custom properties and maps them onto
 * Mermaid's `themeVariables` shape, so diagrams stay visually consistent
 * with whichever built-in theme is active. Read fresh (not cached) on every
 * call — cheap relative to the module load, and it's what keeps a diagram
 * rendered after a theme switch on-palette instead of frozen on the palette
 * active at first use.
 */
export function atriumMermaidThemeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;

  const codeBg = read("--atrium-code-bg", "#1a1d21");
  const textPrimary = read("--atrium-text-primary", "#e6e6e6");
  const border = read("--atrium-border", "#33383e");
  const link = read("--atrium-link", "#6cb2ff");
  const bgSurface = read("--atrium-bg-surface", "#202329");

  return {
    background: codeBg,
    primaryColor: codeBg,
    primaryTextColor: textPrimary,
    primaryBorderColor: border,
    textColor: textPrimary,
    lineColor: border,
    secondaryColor: bgSurface,
    tertiaryColor: bgSurface,
    secondaryBorderColor: border,
    tertiaryBorderColor: border,
    nodeTextColor: textPrimary,
    edgeLabelBackground: bgSurface,
    clusterBkg: bgSurface,
    clusterBorder: border,
    actorTextColor: textPrimary,
    actorBorder: border,
    signalColor: textPrimary,
    signalTextColor: textPrimary,
    labelBoxBkgColor: bgSurface,
    labelTextColor: textPrimary,
    loopTextColor: textPrimary,
    noteBkgColor: bgSurface,
    noteTextColor: textPrimary,
    noteBorderColor: border,
    activationBorderColor: border,
    activationBkgColor: bgSurface,
    sequenceNumberColor: textPrimary,
    linkColor: link,
  };
}

/**
 * Loads (once) and (re-)initializes Mermaid with Atrium's current theme
 * variables. `startOnLoad: false` is required — Mermaid's default behavior
 * scans the whole DOM for `.mermaid` elements on load, which is irrelevant
 * here since every diagram is rendered explicitly by `MermaidWidget`.
 * `securityLevel: "strict"` is set explicitly (matching Mermaid's own
 * default) so the sanitization `MermaidWidget.toDOM()` relies on before
 * assigning the rendered SVG to `innerHTML` is asserted in code, not left to
 * an unstated default a future Mermaid upgrade could silently change.
 */
export async function loadMermaid(): Promise<typeof import("mermaid")> {
  const mod = await importMermaid();
  mod.default.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: atriumMermaidThemeVariables(),
    securityLevel: "strict",
  });
  return mod;
}

/**
 * Most recently rendered SVG markup, keyed by diagram source *and* the theme
 * variables it was rendered with.
 *
 * `MermaidWidget.eq()` lets CodeMirror reuse a widget's DOM across an
 * *incremental* update, but not across a rebuild of the whole content — which
 * is what a scroll landing outside the drawn range triggers — since no old
 * widget survives to compare against. `toDOM` runs again and, rendering
 * asynchronously, returns an empty container for a frame or more; that moves
 * the height map by the diagram's full height and shifts everything below it,
 * which reads as the pane scrolling backward (issue #311). Replaying a cached
 * render makes the re-created widget synchronous, so its height never moves.
 *
 * The theme is part of the key, not just the source, because
 * `atriumMermaidThemeVariables()` is deliberately read fresh on every
 * `loadMermaid()` so diagrams re-render on-palette after a theme switch (see
 * its docstring). Keying on source alone would replay a stale-palette SVG and
 * quietly undo that.
 *
 * Bounded: a diagram being edited yields a distinct entry per keystroke, which
 * would otherwise retain every intermediate version for the process lifetime.
 */
const MAX_CACHED_DIAGRAMS = 64;
const renderedDiagrams = new Map<string, string>();

function diagramCacheKey(source: string): string {
  // NUL separates the two parts: it cannot appear in JSON output and is
  // not valid in diagram source, so no source can spoof a theme boundary.
  return `${JSON.stringify(atriumMermaidThemeVariables())}\0${source}`;
}

/** The cached render for `source` under the current theme, or `undefined`. */
export function cachedMermaidRender(source: string): string | undefined {
  return renderedDiagrams.get(diagramCacheKey(source));
}

/** Empties the cache. Exists so tests start from a known state, since this is module-level and would otherwise leak between them. */
export function clearMermaidRenderCache(): void {
  renderedDiagrams.clear();
}

/** Records `svg` as `source`'s render under the current theme, evicting the least recently used entry past the cap. */
export function cacheMermaidRender(source: string, svg: string): void {
  const key = diagramCacheKey(source);
  // Re-inserting moves the key to the end, making Map iteration order an LRU.
  renderedDiagrams.delete(key);
  renderedDiagrams.set(key, svg);
  for (const oldest of renderedDiagrams.keys()) {
    if (renderedDiagrams.size <= MAX_CACHED_DIAGRAMS) break;
    renderedDiagrams.delete(oldest);
  }
}

/**
 * Extracts a `FencedCode` node's Mermaid diagram source, or `null` if the
 * node isn't tagged ` ```mermaid `. The node's `from`/`to` unambiguously
 * bracket the opening and closing fence lines (or, for an unterminated
 * block, the parser's error-recovery boundary at EOF), so the body is
 * sliced by line position rather than depending on `CodeText`'s exact
 * child shape.
 */
export function extractMermaidSource(state: EditorState, node: SyntaxNode): string | null {
  const info = node.getChild("CodeInfo");
  const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
  if (lang !== "mermaid") {
    return null;
  }

  const firstLine = state.doc.lineAt(node.from);
  const bodyFrom = Math.min(firstLine.to + 1, node.to);

  const marks = node.getChildren("CodeMark");
  const terminated = marks.length > 1;
  const bodyTo = terminated ? Math.max(bodyFrom, state.doc.lineAt(node.to).from - 1) : node.to;

  return state.doc.sliceString(bodyFrom, bodyTo);
}
