import { describe, it, expect } from "vitest";
import { iconKindFor, type IconKind } from "../../src/lib/explorer/icons/iconKind";

function file(name: string): { isDir: boolean; name: string } {
  return { isDir: false, name };
}

const EXTENSION_CASES: Array<[string, IconKind]> = [
  ["notes.md", "markdown"],
  ["README.markdown", "markdown"],
  ["index.js", "javascript"],
  ["component.jsx", "javascript"],
  ["module.mjs", "javascript"],
  ["main.ts", "typescript"],
  ["App.tsx", "typescript"],
  ["script.py", "python"],
  ["lib.rs", "rust"],
  ["main.go", "go"],
  ["data.json", "json"],
  ["config.yaml", "yaml"],
  ["config.yml", "yaml"],
  ["styles.css", "css"],
  ["styles.scss", "css"],
  ["styles.less", "css"],
  ["page.html", "html"],
  ["page.htm", "html"],
  ["build.sh", "shell"],
  ["build.bash", "shell"],
  ["build.zsh", "shell"],
  ["Cargo.toml", "toml"],
  ["photo.png", "image"],
  ["photo.jpg", "image"],
  ["photo.jpeg", "image"],
  ["photo.gif", "image"],
  ["icon.svg", "image"],
  ["photo.webp", "image"],
  ["favicon.ico", "image"],
  ["photo.bmp", "image"],
];

describe("iconKindFor: file extensions", () => {
  for (const [name, expected] of EXTENSION_CASES) {
    it(`maps ${name} to ${expected}`, () => {
      expect(iconKindFor(file(name), false)).toBe(expected);
    });
  }

  it("is case-insensitive", () => {
    expect(iconKindFor(file("photo.PNG"), false)).toBe("image");
    expect(iconKindFor(file("main.RS"), false)).toBe("rust");
  });

  it("falls back to generic for an unknown extension", () => {
    expect(iconKindFor(file("archive.zip"), false)).toBe("generic");
  });

  it("falls back to generic for an extensionless file", () => {
    expect(iconKindFor(file("Makefile"), false)).toBe("generic");
  });

  it("falls back to generic for a dotfile with no extension", () => {
    expect(iconKindFor(file(".gitignore"), false)).toBe("generic");
  });
});

describe("iconKindFor: directories", () => {
  it("resolves to folder-closed when collapsed", () => {
    expect(iconKindFor({ isDir: true, name: "src" }, false)).toBe("folder-closed");
  });

  it("resolves to folder-open when expanded", () => {
    expect(iconKindFor({ isDir: true, name: "src" }, true)).toBe("folder-open");
  });
});
