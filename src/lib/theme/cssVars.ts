import type { Theme, ThemeTokens } from "./tokens";

function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Applies every `ThemeTokens` field to `document.documentElement` as a
 * `--atrium-<kebab-case-token-name>` custom property (e.g. `bgBase` ->
 * `--atrium-bg-base`), and sets `dataset.theme`/`colorScheme` to the theme's
 * appearance so native form controls and `prefers-color-scheme`-aware CSS
 * follow along. This is the only place that writes theme CSS variables —
 * every app-chrome consumer (`app.css`, the Svelte components' own
 * `<style>` blocks, `markdown.css`) reads the `--atrium-*` vars this
 * function sets. `cmTheme.ts` and `xtermTheme.ts` instead read a `Theme`'s
 * token values directly in JS, bypassing CSS vars entirely — CodeMirror and
 * xterm.js both configure their own colors imperatively, not via CSS.
 */
export function applyThemeToDocument(theme: Theme): void {
  const root = document.documentElement;
  for (const key of Object.keys(theme.tokens) as (keyof ThemeTokens)[]) {
    root.style.setProperty(`--atrium-${kebabCase(key)}`, theme.tokens[key]);
  }
  root.dataset.theme = theme.appearance;
  root.style.colorScheme = theme.appearance;
}
