import { describe, it, expect, beforeEach } from "vitest";
import { applyThemeToDocument } from "../../src/lib/theme/cssVars";
import { atriumDark, atriumLight } from "../../src/lib/theme/tokens";
import type { ThemeTokens } from "../../src/lib/theme/tokens";

function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

beforeEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

describe("applyThemeToDocument", () => {
  it("sets one --atrium-<kebab-case> CSS var per ThemeTokens field", () => {
    applyThemeToDocument(atriumDark);

    const root = document.documentElement;
    for (const key of Object.keys(atriumDark.tokens) as (keyof ThemeTokens)[]) {
      expect(root.style.getPropertyValue(`--atrium-${kebabCase(key)}`)).toBe(atriumDark.tokens[key]);
    }
  });

  it("sets dataset.theme and colorScheme to the theme's appearance, and flips them between themes", () => {
    applyThemeToDocument(atriumDark);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyThemeToDocument(atriumLight);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("overwrites previously-applied token values when switching themes", () => {
    applyThemeToDocument(atriumDark);
    expect(document.documentElement.style.getPropertyValue("--atrium-bg-base")).toBe(atriumDark.tokens.bgBase);

    applyThemeToDocument(atriumLight);
    expect(document.documentElement.style.getPropertyValue("--atrium-bg-base")).toBe(atriumLight.tokens.bgBase);
  });
});
