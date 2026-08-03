import { describe, it, expect } from "vitest";
import { languageLabel } from "../../src/lib/editor/languageLabel";

describe("languageLabel", () => {
  const cases: [string, string][] = [
    ["/a/b.js", "JavaScript"],
    ["/a/b.jsx", "JavaScript"],
    ["/a/b.mjs", "JavaScript"],
    ["/a/b.ts", "TypeScript"],
    ["/a/b.tsx", "TypeScript"],
    ["/a/b.py", "Python"],
    ["/a/b.rs", "Rust"],
    ["/a/b.go", "Go"],
    ["/a/b.json", "JSON"],
    ["/a/b.yaml", "YAML"],
    ["/a/b.yml", "YAML"],
    ["/a/b.css", "CSS"],
    ["/a/b.html", "HTML"],
    ["/a/b.sh", "Shell Script"],
    ["/a/b.bash", "Shell Script"],
    ["/a/b.zsh", "Shell Script"],
    ["/a/b.toml", "TOML"],
    ["/a/b.tf", "Terraform"],
    ["/a/b.tfvars", "Terraform"],
    ["/a/b.hcl", "HCL"],
    ["/a/b.c", "C"],
    ["/a/b.cpp", "C++"],
    ["/a/b.cs", "C#"],
    ["/a/b.java", "Java"],
    ["/a/b.kt", "Kotlin"],
    ["/a/b.swift", "Swift"],
    ["/a/b.rb", "Ruby"],
    ["/a/b.php", "PHP"],
    ["/a/b.sql", "SQL"],
    ["/a/b.xml", "XML"],
    ["/a/b.scss", "SCSS"],
    ["/a/b.less", "LESS"],
    ["/a/b.lua", "Lua"],
    ["/a/b.ps1", "PowerShell"],
    ["/a/b.proto", "ProtoBuf"],
    ["/a/b.md", "Markdown"],
    ["/a/Dockerfile", "Dockerfile"],
    ["/a/b.markdown", "Markdown"],
  ];

  for (const [path, expected] of cases) {
    it(`maps ${path} to ${expected}`, () => {
      expect(languageLabel(path)).toBe(expected);
    });
  }

  it("is case-insensitive on the extension", () => {
    expect(languageLabel("/a/B.TS")).toBe("TypeScript");
    expect(languageLabel("/a/config.TOML")).toBe("TOML");
  });

  it("falls back to Plain Text for an unrecognized extension", () => {
    expect(languageLabel("/a/b.xyz")).toBe("Plain Text");
  });

  it("falls back to Plain Text for an extensionless file", () => {
    expect(languageLabel("/a/README")).toBe("Plain Text");
  });
});
