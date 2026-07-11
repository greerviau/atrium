import { describe, it, expect } from "vitest";
import { PR_LINK_REGEX } from "../../src/lib/terminal/prLinkRegex";
import { FILE_PATH_REGEX } from "../../src/lib/terminal/filePathRegex";

describe("PR_LINK_REGEX", () => {
  it("matches a github pull request url embedded in surrounding text", () => {
    const line = "See https://github.com/anthropics/claude-code/pull/1234 for details";
    const matches = [...line.matchAll(PR_LINK_REGEX)];
    expect(matches).toHaveLength(1);
    expect(matches[0][0]).toBe("https://github.com/anthropics/claude-code/pull/1234");
  });

  it("does not match a plain repo or issue url", () => {
    const line = "https://github.com/anthropics/claude-code and https://github.com/anthropics/claude-code/issues/1";
    expect([...line.matchAll(PR_LINK_REGEX)]).toHaveLength(0);
  });
});

describe("FILE_PATH_REGEX", () => {
  const cases: [string, string[]][] = [
    ["Modified src/lib/editor/EditorPane.svelte", ["src/lib/editor/EditorPane.svelte"]],
    ["error at src-tauri/src/main.rs:42:7", ["src-tauri/src/main.rs:42:7"]],
    ["./relative/path.ts:10", ["./relative/path.ts:10"]],
    ["  package.json | 3 +++", ["package.json"]],
    ["just some prose with no path here", []],
  ];

  it.each(cases)("matches candidates in %j", (line, expected) => {
    const matches = [...line.matchAll(FILE_PATH_REGEX)].map((m) => m[0]);
    expect(matches).toEqual(expected);
  });
});
