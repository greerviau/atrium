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

/**
 * xterm.js's own built-in defaults (used when no `theme` option is passed
 * at all), read directly from its source
 * (`node_modules/@xterm/xterm/src/browser/services/ThemeService.ts`). Atrium
 * Dark's `bgBase` (`#1a1d21`) is visually close to xterm's default
 * background (`#000000`) — both read as "black" at a glance — so a bug that
 * silently dropped the `theme` option from the `Terminal` constructor could
 * go unnoticed by eye. These values pin down xterm's actual default so the
 * tests below can assert Atrium's theme is a deliberately different,
 * non-default value, not a coincidental visual match.
 */
const XTERM_DEFAULTS = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  ansi: [
    "#2e3436",
    "#cc0000",
    "#4e9a06",
    "#c4a000",
    "#3465a4",
    "#75507b",
    "#06989a",
    "#d3d7cf",
    "#555753",
    "#ef2929",
    "#8ae234",
    "#fce94f",
    "#729fcf",
    "#ad7fa8",
    "#34e2e2",
    "#eeeeec",
  ],
};

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

describe("buildXtermTheme is a real theme, not a coincidental match to xterm's own default", () => {
  it.each(themes)("$id's full 16-slot ANSI ramp differs from xterm's built-in default ramp", (theme) => {
    const xtermTheme = buildXtermTheme(theme);
    const ourRamp = ANSI_SLOTS.map((slot) => xtermTheme[slot]);
    // Every slot is a real, curated color (never undefined/empty), and the
    // ramp as a whole is not xterm's own default ramp verbatim — a
    // wiring bug that dropped the theme option would leave xterm falling
    // back to XTERM_DEFAULTS.ansi exactly.
    for (const value of ourRamp) {
      expect(value).toBeTypeOf("string");
    }
    expect(ourRamp).not.toEqual(XTERM_DEFAULTS.ansi);
    // Stronger than "the 16-tuple differs somewhere": most individual
    // slots differ too, ruling out a bug that wired through only one slot.
    const matchingSlots = ourRamp.filter((value, i) => value === XTERM_DEFAULTS.ansi[i]).length;
    expect(matchingSlots).toBeLessThan(ourRamp.length / 2);
  });

  it("Atrium Dark and Atrium Light backgrounds are deliberately different values from xterm's default black/white, not a coincidental visual match", () => {
    // (Atrium High Contrast is excluded here: its background/foreground are
    // intentionally pure black/white, which happens to equal xterm's own
    // defaults — its ANSI ramp, checked above, is what proves its theme is
    // actually wired through.)
    expect(buildXtermTheme(atriumDark).background).not.toBe(XTERM_DEFAULTS.background);
    expect(buildXtermTheme(atriumLight).background).not.toBe(XTERM_DEFAULTS.background);
    expect(buildXtermTheme(atriumLight).foreground).not.toBe(XTERM_DEFAULTS.foreground);
  });

  it("no two of the three built-in themes produce the same ITheme", () => {
    const [dark, light, highContrast] = themes.map(buildXtermTheme);
    expect(dark).not.toEqual(light);
    expect(dark).not.toEqual(highContrast);
    expect(light).not.toEqual(highContrast);
  });
});
