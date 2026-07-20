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
  "dangerText",
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

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two opaque hex colors: (L1+0.05)/(L2+0.05), lighter over darker. */
function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe("dangerText passes WCAG AA against danger in every theme (a delete button's fill and text)", () => {
  it.each(themes)("$id: dangerText on danger clears 4.5:1", (theme) => {
    const ratio = contrastRatio(theme.tokens.dangerText, theme.tokens.danger);
    expect(ratio, `${theme.id}: dangerText ${theme.tokens.dangerText} on danger ${theme.tokens.danger} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it("dangerText is not simply textPrimary or textInverse reused verbatim in Atrium Dark (neither clears AA there)", () => {
    expect(contrastRatio(atriumDark.tokens.textPrimary, atriumDark.tokens.danger)).toBeLessThan(4.5);
    expect(contrastRatio(atriumDark.tokens.textInverse, atriumDark.tokens.danger)).toBeLessThan(4.5);
    expect(atriumDark.tokens.dangerText).not.toBe(atriumDark.tokens.textPrimary);
    expect(atriumDark.tokens.dangerText).not.toBe(atriumDark.tokens.textInverse);
  });
});
