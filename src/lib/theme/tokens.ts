/**
 * The single source of truth for Atrium's color palette. A `Theme` is a flat
 * set of named color tokens (`ThemeTokens`) plus the metadata needed to
 * select and apply it. `cssVars.ts`, `cmTheme.ts`, and `xtermTheme.ts` each
 * derive one surface's colors from the same `Theme` record, so app chrome,
 * the CodeMirror editor, and the xterm terminal never drift out of sync.
 */
export interface ThemeTokens {
  // App chrome
  bgBase: string; // main canvas: editor background, terminal background
  bgSurface: string; // explorer, tab strip, terminal chrome
  bgElevated: string; // menus, modals, context menu
  bgHover: string;
  bgActive: string; // active tab / selected row
  border: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string; // text on top of an accent-colored surface
  accent: string;
  link: string;
  danger: string;
  warning: string;
  warningBg: string; // conflict-banner background
  codeBg: string; // inline-code chip background (markdown)

  // Editor chrome (consumed by EditorView.theme())
  gutterBg: string;
  gutterFg: string;
  gutterFgActiveLine: string;
  cursor: string;
  selectionBg: string;
  activeLineBg: string;
  matchingBracketBg: string;
  searchMatchBg: string;

  // Syntax highlighting (consumed by HighlightStyle.define())
  syntaxKeyword: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxComment: string;
  syntaxFunction: string;
  syntaxType: string;
  syntaxProperty: string;
  syntaxOperator: string;
  syntaxInvalid: string;
}

export interface Theme {
  id: string;
  name: string;
  appearance: "dark" | "light";
  tokens: ThemeTokens;
}

export const atriumDark: Theme = {
  id: "atrium-dark",
  name: "Atrium Dark",
  appearance: "dark",
  tokens: {
    bgBase: "#1a1d21",
    bgSurface: "#202329",
    bgElevated: "#262a30",
    bgHover: "rgba(255,255,255,0.06)",
    bgActive: "rgba(255,255,255,0.10)",
    border: "#33383e",
    borderSubtle: "#2a2e34",
    textPrimary: "#e6e6e6",
    textSecondary: "#b4b8bf",
    textMuted: "#8a8f98",
    textInverse: "#1a1d21",
    accent: "#5b9dff",
    link: "#6cb2ff",
    danger: "#e5484d",
    warning: "#e8a33d",
    warningBg: "#7a4a1a",
    codeBg: "rgba(255,255,255,0.08)",
    gutterBg: "#1a1d21",
    gutterFg: "#8a8f98",
    gutterFgActiveLine: "#c9cdd3",
    cursor: "#e6e6e6",
    selectionBg: "rgba(91,157,255,0.25)",
    activeLineBg: "rgba(255,255,255,0.04)",
    matchingBracketBg: "rgba(91,157,255,0.35)",
    searchMatchBg: "rgba(255,214,0,0.35)",
    syntaxKeyword: "#c586c0",
    syntaxString: "#ce9178",
    syntaxNumber: "#b5cea8",
    syntaxComment: "#6a7280",
    syntaxFunction: "#dcdcaa",
    syntaxType: "#4ec9b0",
    syntaxProperty: "#9cdcfe",
    syntaxOperator: "#d4d4d4",
    syntaxInvalid: "#f44747",
  },
};

export const atriumLight: Theme = {
  id: "atrium-light",
  name: "Atrium Light",
  appearance: "light",
  tokens: {
    bgBase: "#ffffff",
    bgSurface: "#f5f6f8",
    bgElevated: "#ffffff",
    bgHover: "rgba(0,0,0,0.04)",
    bgActive: "rgba(0,0,0,0.07)",
    border: "#d8dbe0",
    borderSubtle: "#e9ebee",
    textPrimary: "#1a1d21",
    textSecondary: "#444b54",
    textMuted: "#6b7078",
    textInverse: "#ffffff",
    accent: "#1a73e8",
    link: "#1a73e8",
    danger: "#d0342c",
    warning: "#a35b00",
    warningBg: "#fbe4c8",
    codeBg: "rgba(0,0,0,0.05)",
    gutterBg: "#ffffff",
    gutterFg: "#6b7078",
    gutterFgActiveLine: "#3b3f45",
    cursor: "#1a1d21",
    selectionBg: "rgba(26,115,232,0.15)",
    activeLineBg: "rgba(0,0,0,0.03)",
    matchingBracketBg: "rgba(26,115,232,0.28)",
    searchMatchBg: "rgba(255,193,7,0.35)",
    syntaxKeyword: "#a626a4",
    syntaxString: "#50a154",
    syntaxNumber: "#986801",
    syntaxComment: "#6e7781",
    syntaxFunction: "#4078f2",
    syntaxType: "#c18401",
    syntaxProperty: "#e45649",
    syntaxOperator: "#383a42",
    syntaxInvalid: "#ca1243",
  },
};

export const atriumHighContrast: Theme = {
  id: "atrium-high-contrast",
  name: "Atrium High Contrast",
  appearance: "dark",
  tokens: {
    bgBase: "#000000",
    bgSurface: "#0a0a0a",
    bgElevated: "#141414",
    bgHover: "rgba(255,255,255,0.12)",
    bgActive: "rgba(255,255,255,0.18)",
    border: "rgba(255,255,255,0.3)",
    borderSubtle: "rgba(255,255,255,0.15)",
    textPrimary: "#ffffff",
    textSecondary: "#e0e0e0",
    textMuted: "#c4c4c4",
    textInverse: "#000000",
    accent: "#66d9ff",
    link: "#66d9ff",
    danger: "#ff6b6b",
    warning: "#ffd54f",
    warningBg: "#4d3800",
    codeBg: "rgba(255,255,255,0.12)",
    gutterBg: "#000000",
    gutterFg: "#cfd3d8",
    gutterFgActiveLine: "#ffffff",
    cursor: "#ffffff",
    selectionBg: "rgba(102,217,255,0.35)",
    activeLineBg: "rgba(255,255,255,0.08)",
    matchingBracketBg: "rgba(102,217,255,0.45)",
    searchMatchBg: "rgba(255,214,0,0.45)",
    syntaxKeyword: "#e5a8de",
    syntaxString: "#f0ab8c",
    syntaxNumber: "#d6edb8",
    syntaxComment: "#9aa4b0",
    syntaxFunction: "#f0e6a8",
    syntaxType: "#7fe6cc",
    syntaxProperty: "#b8e4ff",
    syntaxOperator: "#f0f0f0",
    syntaxInvalid: "#ff8a80",
  },
};

/** Every built-in theme, in menu-display order (Atrium Dark, Atrium Light, Atrium High Contrast). */
export const themes: Theme[] = [atriumDark, atriumLight, atriumHighContrast];

/** Looks up a built-in theme by id, or `undefined` if `id` isn't a built-in theme id (e.g. `"auto"`). */
export function themeById(id: string): Theme | undefined {
  return themes.find((theme) => theme.id === id);
}
