import { describe, it, expect } from "vitest";
import { buildXtermTheme } from "../../src/lib/theme/xtermTheme";
import { atriumDark, atriumLight, atriumHighContrast, themes } from "../../src/lib/theme/tokens";
import type { ITheme } from "@xterm/xterm";

const ANSI_SLOTS: (keyof ITheme)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

describe("buildXtermTheme", () => {
  it.each(themes)("sets background/foreground/cursor/selection from $id's UI tokens", (theme) => {
    const xtermTheme = buildXtermTheme(theme);
    expect(xtermTheme.background).toBe(theme.tokens.bgBase);
    expect(xtermTheme.foreground).toBe(theme.tokens.textPrimary);
    expect(xtermTheme.cursor).toBe(theme.tokens.cursor);
    expect(xtermTheme.cursorAccent).toBe(theme.tokens.bgBase);
    expect(xtermTheme.selectionBackground).toBe(theme.tokens.selectionBg);
  });

  it.each(themes)("sets all 16 ANSI slots for $id", (theme) => {
    const xtermTheme = buildXtermTheme(theme);
    for (const slot of ANSI_SLOTS) {
      expect(xtermTheme[slot], `${theme.id}.${slot}`).toBeTypeOf("string");
      expect(xtermTheme[slot], `${theme.id}.${slot}`).not.toBe("");
    }
  });

  it("matches the plan's Atrium Dark ANSI ramp exactly", () => {
    expect(buildXtermTheme(atriumDark)).toEqual({
      background: "#1a1d21",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
      cursorAccent: "#1a1d21",
      selectionBackground: "rgba(91,157,255,0.25)",
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
    });
  });

  it("matches the plan's Atrium Light ANSI ramp exactly", () => {
    expect(buildXtermTheme(atriumLight)).toEqual({
      background: "#ffffff",
      foreground: "#1a1d21",
      cursor: "#1a1d21",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(26,115,232,0.15)",
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
    });
  });

  it("matches the plan's Atrium High Contrast ANSI ramp exactly", () => {
    expect(buildXtermTheme(atriumHighContrast)).toEqual({
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffffff",
      cursorAccent: "#000000",
      selectionBackground: "rgba(102,217,255,0.35)",
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
    });
  });
});
