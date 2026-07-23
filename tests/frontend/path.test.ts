import { describe, it, expect } from "vitest";
import { basename, dirOf } from "../../src/lib/util/path";

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

  it("returns a single-segment path unchanged", () => {
    expect(basename("folder")).toBe("folder");
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
