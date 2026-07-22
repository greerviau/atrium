import { describe, it, expect } from "vitest";
import { shellQuotePath, shellQuotePaths } from "../../src/lib/terminal/shellQuote";

describe("shellQuotePath", () => {
  it("leaves a plain path untouched", () => {
    expect(shellQuotePath("/Users/greer/projects/atrium/src/App.svelte")).toBe(
      "/Users/greer/projects/atrium/src/App.svelte",
    );
  });

  it("single-quotes a path containing a space", () => {
    expect(shellQuotePath("/Users/greer/My Documents/file.txt")).toBe(
      "'/Users/greer/My Documents/file.txt'",
    );
  });

  it("escapes an embedded single quote", () => {
    expect(shellQuotePath("/Users/greer/it's a folder/file.txt")).toBe(
      "'/Users/greer/it'\\''s a folder/file.txt'",
    );
  });

  it("single-quotes a path containing a shell metacharacter", () => {
    expect(shellQuotePath("/Users/greer/foo$bar")).toBe("'/Users/greer/foo$bar'");
  });
});

describe("shellQuotePaths", () => {
  it("returns an empty string for an empty array", () => {
    expect(shellQuotePaths([])).toBe("");
  });

  it("returns the path plus a trailing space for one plain path", () => {
    expect(shellQuotePaths(["/Users/greer/projects/atrium/src/App.svelte"])).toBe(
      "/Users/greer/projects/atrium/src/App.svelte ",
    );
  });

  it("quotes a single path needing quoting plus a trailing space, matching today's single-path behavior exactly", () => {
    expect(shellQuotePaths(["/Users/greer/My Documents/file.txt"])).toBe(
      "'/Users/greer/My Documents/file.txt' ",
    );
  });

  it("space-joins multiple mixed paths, quoting only the ones that need it, with one trailing space at the end", () => {
    expect(
      shellQuotePaths(["/Users/greer/projects/atrium", "/Users/greer/My Documents/file.txt"]),
    ).toBe("/Users/greer/projects/atrium '/Users/greer/My Documents/file.txt' ");
  });
});
