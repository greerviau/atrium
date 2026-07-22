import { describe, it, expect } from "vitest";
import { shellQuotePath } from "../../src/lib/terminal/shellQuote";

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
