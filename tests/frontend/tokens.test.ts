import { describe, it, expect } from "vitest";
import { atriumDark, atriumLight, atriumHighContrast, themes, themeById } from "../../src/lib/theme/tokens";
import type { ThemeTokens } from "../../src/lib/theme/tokens";

const TOKEN_KEYS: (keyof ThemeTokens)[] = [
  "bgBase",
  "bgSurface",
  "bgElevated",
  "bgHover",
  "bgActive",
  "border",
  "borderSubtle",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "textInverse",
  "accent",
  "link",
  "danger",
  "warning",
  "warningBg",
  "codeBg",
  "gutterBg",
  "gutterFg",
  "gutterFgActiveLine",
  "cursor",
  "selectionBg",
  "activeLineBg",
  "matchingBracketBg",
  "searchMatchBg",
  "syntaxKeyword",
  "syntaxString",
  "syntaxNumber",
  "syntaxComment",
  "syntaxFunction",
  "syntaxType",
  "syntaxProperty",
  "syntaxOperator",
  "syntaxInvalid",
];

describe("built-in themes", () => {
  it("ship exactly the three documented built-in themes, in menu order", () => {
    expect(themes).toEqual([atriumDark, atriumLight, atriumHighContrast]);
  });

  it.each([
    ["atrium-dark", atriumDark, "dark"],
    ["atrium-light", atriumLight, "light"],
    ["atrium-high-contrast", atriumHighContrast, "dark"],
  ] as const)("%s has id %s and appearance %s", (id, theme, appearance) => {
    expect(theme.id).toBe(id);
    expect(theme.appearance).toBe(appearance);
  });

  it.each([
    ["Atrium Dark", atriumDark],
    ["Atrium Light", atriumLight],
    ["Atrium High Contrast", atriumHighContrast],
  ] as const)("every field of ThemeTokens is populated for %s (no partial records)", (_name, theme) => {
    for (const key of TOKEN_KEYS) {
      expect(theme.tokens[key], `${theme.id}.${key}`).toBeTypeOf("string");
      expect(theme.tokens[key], `${theme.id}.${key}`).not.toBe("");
    }
    expect(Object.keys(theme.tokens).sort()).toEqual([...TOKEN_KEYS].sort());
  });
});

describe("themeById", () => {
  it("resolves each built-in theme by id", () => {
    expect(themeById("atrium-dark")).toBe(atriumDark);
    expect(themeById("atrium-light")).toBe(atriumLight);
    expect(themeById("atrium-high-contrast")).toBe(atriumHighContrast);
  });

  it("returns undefined for a non-built-in id (e.g. the Auto sentinel)", () => {
    expect(themeById("auto")).toBeUndefined();
    expect(themeById("nonsense")).toBeUndefined();
  });
});

describe("corrected values per the implementation plan's WCAG audit", () => {
  it("gutterFg equals textMuted in Atrium Dark and Atrium Light", () => {
    expect(atriumDark.tokens.gutterFg).toBe(atriumDark.tokens.textMuted);
    expect(atriumLight.tokens.gutterFg).toBe(atriumLight.tokens.textMuted);
  });

  it("Atrium Light's syntaxComment is the AA-corrected value, not the spec's original", () => {
    expect(atriumLight.tokens.syntaxComment).toBe("#6e7781");
  });

  it("the conflict-banner's warningBg is unchanged from today's literal", () => {
    expect(atriumDark.tokens.warningBg).toBe("#7a4a1a");
  });
});
