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
 * every consumer (app chrome CSS, the CodeMirror gutter theme's fallback,
 * markdown.css) reads `--atrium-*` vars this function sets.
 */
export function applyThemeToDocument(theme: Theme): void {
  const root = document.documentElement;
  for (const key of Object.keys(theme.tokens) as (keyof ThemeTokens)[]) {
    root.style.setProperty(`--atrium-${kebabCase(key)}`, theme.tokens[key]);
  }
  root.dataset.theme = theme.appearance;
  root.style.colorScheme = theme.appearance;
}
