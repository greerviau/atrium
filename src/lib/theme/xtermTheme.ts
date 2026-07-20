import type { ITheme } from "@xterm/xterm";
import type { Theme } from "./tokens";

const ANSI: Record<string, Omit<ITheme, "foreground" | "background" | "cursor" | "cursorAccent" | "selectionBackground">> = {
  "atrium-dark": {
    black: "#2a2e34",
    red: "#e5484d",
    green: "#4fb477",
    yellow: "#e8a33d",
    blue: "#5b9dff",
    magenta: "#c586c0",
    cyan: "#4ec9b0",
    white: "#b4b8bf",
    brightBlack: "#6b7078",
    brightRed: "#f5696e",
    brightGreen: "#6fd699",
    brightYellow: "#f0b95c",
    brightBlue: "#7cb3ff",
    brightMagenta: "#dba6d6",
    brightCyan: "#6edfc4",
    brightWhite: "#e6e6e6",
  },
  "atrium-light": {
    black: "#383a42",
    red: "#d0342c",
    green: "#50a154",
    yellow: "#986801",
    blue: "#1a73e8",
    magenta: "#a626a4",
    cyan: "#0997b3",
    white: "#a0a1a7",
    brightBlack: "#696c77",
    brightRed: "#e5484d",
    brightGreen: "#6fbf73",
    brightYellow: "#c18401",
    brightBlue: "#4078f2",
    brightMagenta: "#c33ec0",
    brightCyan: "#2bb3d4",
    brightWhite: "#1a1d21",
  },
  "atrium-high-contrast": {
    black: "#1a1a1a",
    red: "#ff6b6b",
    green: "#a8e890",
    yellow: "#ffd54f",
    blue: "#66d9ff",
    magenta: "#e5a8de",
    cyan: "#7fe6cc",
    white: "#e8e8e8",
    brightBlack: "#9aa4b0",
    brightRed: "#ff8a80",
    brightGreen: "#c3f0b0",
    brightYellow: "#ffe082",
    brightBlue: "#a8e8ff",
    brightMagenta: "#f0c8ec",
    brightCyan: "#b3f5e6",
    brightWhite: "#ffffff",
  },
};

/**
 * Maps a `Theme` to xterm's `ITheme`: background/foreground/cursor from the
 * corresponding UI tokens, plus a curated 16-slot ANSI ramp per theme
 * (`xtermTheme.ts`-only colors where no existing token fits a plain ANSI
 * hue, e.g. green/cyan) that keeps the terminal visually part of the same
 * theme as the rest of the app.
 */
export function buildXtermTheme(theme: Theme): ITheme {
  const t = theme.tokens;
  return {
    background: t.bgBase,
    foreground: t.textPrimary,
    cursor: t.cursor,
    cursorAccent: t.bgBase,
    selectionBackground: t.selectionBg,
    ...ANSI[theme.id],
  };
}
