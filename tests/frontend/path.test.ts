import { describe, it, expect } from "vitest";
import { basename, dirOf, isPathUnderOrEqual, pathsEqual } from "../../src/lib/util/path";

describe("basename", () => {
  it("returns the last segment of a plain path", () => {
    expect(basename("/a/b/folder")).toBe("folder");
  });

  it("strips a trailing slash before taking the last segment", () => {
    expect(basename("/a/b/folder/")).toBe("folder");
  });

  it("normalizes backslashes before splitting", () => {
    expect(basename("C:\\a\\b\\folder")).toBe("folder");
  });

  it("strips a trailing backslash before taking the last segment", () => {
    expect(basename("C:\\a\\b\\folder\\")).toBe("folder");
  });

  it("returns a single-segment path unchanged", () => {
    expect(basename("folder")).toBe("folder");
  });

  it("returns the segment of a rooted single-segment path", () => {
    expect(basename("/atrium")).toBe("atrium");
  });

  it("falls back to the input when the basename is empty", () => {
    expect(basename("/")).toBe("/");
  });

  it("falls back to the input for an empty string", () => {
    expect(basename("")).toBe("");
  });
});

describe("dirOf", () => {
  it("returns the parent directory of a nested path", () => {
    expect(dirOf("/a/b/notes.txt")).toBe("/a/b");
  });

  it("normalizes backslashes before splitting", () => {
    expect(dirOf("C:\\a\\b\\notes.txt")).toBe("C:/a/b");
  });

  it("falls back to the input for a root-level path", () => {
    expect(dirOf("/notes.txt")).toBe("/notes.txt");
  });

  it("falls back to the input for a single-segment path", () => {
    expect(dirOf("notes.txt")).toBe("notes.txt");
  });
});

describe("isPathUnderOrEqual", () => {
  it("matches the exact same path", () => {
    expect(isPathUnderOrEqual("/a/b/notes.txt", "/a/b/notes.txt")).toBe(true);
  });

  it("matches a descendant of a directory prefix", () => {
    expect(isPathUnderOrEqual("/a/b/search/file.ts", "/a/b/search")).toBe(true);
  });

  it("does not match a sibling whose name merely shares the prefix as a string", () => {
    expect(isPathUnderOrEqual("/a/b/searching/file.ts", "/a/b/search")).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(isPathUnderOrEqual("/a/c/file.ts", "/a/b")).toBe(false);
  });

  it("normalizes backslashes on both sides before comparing", () => {
    expect(isPathUnderOrEqual("C:\\a\\b\\file.ts", "C:\\a\\b")).toBe(true);
  });

  it("tolerates a trailing slash on the prefix", () => {
    expect(isPathUnderOrEqual("/a/b/file.ts", "/a/b/")).toBe(true);
  });
});

describe("pathsEqual", () => {
  it("matches identical paths", () => {
    expect(pathsEqual("/a/b/notes.txt", "/a/b/notes.txt")).toBe(true);
  });

  it("matches the same path in native-backslash form against forward-slash form", () => {
    expect(pathsEqual("C:\\ws\\src\\index.ts", "C:/ws/src/index.ts")).toBe(true);
  });

  it("tolerates a trailing slash on one side", () => {
    expect(pathsEqual("/a/b/", "/a/b")).toBe(true);
  });

  it("does not match a descendant, unlike isPathUnderOrEqual", () => {
    expect(pathsEqual("/a/b/file.ts", "/a/b")).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(pathsEqual("/a/b/file.ts", "/a/c/file.ts")).toBe(false);
  });
});
