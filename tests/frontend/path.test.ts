import { describe, it, expect } from "vitest";
import {
  basename,
  canonicalizePath,
  dirOf,
  isPathUnderOrEqual,
  joinPath,
  pathsEqual,
  rekeyUnder,
  relativeToRoot,
} from "../../src/lib/util/path";
import canonicalPathVectors from "../fixtures/canonical-path-vectors.json";

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

describe("relativeToRoot", () => {
  it("strips a Unix root without a trailing slash", () => {
    expect(relativeToRoot("/proj/src/app.ts", "/proj")).toBe("src/app.ts");
  });

  it("strips a Unix root with a trailing slash", () => {
    expect(relativeToRoot("/proj/src/app.ts", "/proj/")).toBe("src/app.ts");
  });

  it("strips a Windows root and returns a forward-slash result", () => {
    expect(relativeToRoot("C:\\ws\\src\\notes.md", "C:\\ws")).toBe("src/notes.md");
  });

  it("strips a Windows root with a trailing backslash", () => {
    expect(relativeToRoot("C:\\ws\\src\\notes.md", "C:\\ws\\")).toBe("src/notes.md");
  });

  it("matches a forward-slash path against a backslash root", () => {
    expect(relativeToRoot("C:/ws/src/notes.md", "C:\\ws")).toBe("src/notes.md");
  });

  it("returns an out-of-root path verbatim, in its native form", () => {
    expect(relativeToRoot("/other/f.ts", "/proj")).toBe("/other/f.ts");
  });

  it("returns a native-separator out-of-root path unchanged, not forward-slashed", () => {
    expect(relativeToRoot("D:\\other\\f.ts", "C:\\ws")).toBe("D:\\other\\f.ts");
  });

  it("does not match a sibling directory whose name merely shares the root as a string prefix", () => {
    expect(relativeToRoot("/a/b/searching/f.ts", "/a/b/search")).toBe("/a/b/searching/f.ts");
  });

  it("returns the root itself unchanged when path equals root", () => {
    expect(relativeToRoot("/proj", "/proj")).toBe("/proj");
  });

  it("strips a root of just a slash", () => {
    expect(relativeToRoot("/a/b.md", "/")).toBe("a/b.md");
  });

  it("returns the path unchanged when root is null", () => {
    expect(relativeToRoot("/proj/src/app.ts", null)).toBe("/proj/src/app.ts");
  });

  it("returns the path unchanged when root is undefined", () => {
    expect(relativeToRoot("/proj/src/app.ts", undefined)).toBe("/proj/src/app.ts");
  });
});

describe("canonicalizePath", () => {
  it("strips a verbatim disk prefix and folds separators", () => {
    expect(canonicalizePath("\\\\?\\C:\\ws\\a.ts")).toBe("C:/ws/a.ts");
  });

  it("strips a verbatim UNC prefix to the canonical double-forward-slash form", () => {
    expect(canonicalizePath("\\\\?\\UNC\\srv\\share\\a.ts")).toBe("//srv/share/a.ts");
  });

  it("strips a trailing backslash on a subdirectory", () => {
    expect(canonicalizePath("C:\\ws\\")).toBe("C:/ws");
  });

  it("keeps the trailing separator on a bare drive root", () => {
    expect(canonicalizePath("C:\\")).toBe("C:/");
  });

  it("collapses repeated backslashes to a single forward slash", () => {
    expect(canonicalizePath("C:\\ws\\\\src")).toBe("C:/ws/src");
  });

  it("leaves an already-canonical UNC path unchanged", () => {
    expect(canonicalizePath("//srv/share")).toBe("//srv/share");
  });

  it("leaves an already-canonical POSIX path unchanged", () => {
    expect(canonicalizePath("/home/me/a.ts")).toBe("/home/me/a.ts");
  });

  it("preserves a literal backslash in a POSIX filename instead of folding it", () => {
    expect(canonicalizePath("/home/me/we\\ird")).toBe("/home/me/we\\ird");
  });

  it("is idempotent", () => {
    const inputs = [
      "\\\\?\\C:\\ws\\a.ts",
      "\\\\?\\UNC\\srv\\share\\a.ts",
      "C:\\ws\\",
      "C:\\",
      "//srv/share",
      "/home/me/a.ts",
      "/home/me/we\\ird",
    ];
    for (const input of inputs) {
      const once = canonicalizePath(input);
      expect(canonicalizePath(once)).toBe(once);
    }
  });

  describe("against the shared frontend/backend vector fixture", () => {
    // A count floor so a truncated or unparsed fixture can't pass vacuously
    // — mirrors the same floor `path_key.rs`'s own test applies to the same
    // file.
    it("has at least 15 vectors", () => {
      expect(canonicalPathVectors.length).toBeGreaterThanOrEqual(15);
    });

    for (const vector of canonicalPathVectors) {
      it(`${vector.description} (${JSON.stringify(vector.input)} -> ${JSON.stringify(vector.expected)})`, () => {
        expect(canonicalizePath(vector.input)).toBe(vector.expected);
      });
    }
  });
});

describe("joinPath", () => {
  it("joins a canonical directory and a name", () => {
    expect(joinPath("C:/ws/src", "a.ts")).toBe("C:/ws/src/a.ts");
  });

  it("tolerates a trailing backslash on a native Windows directory", () => {
    expect(joinPath("C:\\ws\\src\\", "a.ts")).toBe("C:/ws/src/a.ts");
  });

  it("tolerates a trailing slash on a POSIX directory", () => {
    expect(joinPath("/a/b/", "c")).toBe("/a/b/c");
  });
});

describe("rekeyUnder", () => {
  it("re-addresses a path from under oldPath to under newPath", () => {
    expect(rekeyUnder("/a/b/notes.txt", "/a/b", "/a/c")).toBe("/a/c/notes.txt");
  });

  it("does not corrupt the offset when oldPath has a trailing separator (issue #459)", () => {
    expect(rekeyUnder("C:/ws/src/a.ts", "C:/ws/src/", "C:/ws/dst")).toBe("C:/ws/dst/a.ts");
  });

  it("returns null when path is not under oldPath", () => {
    expect(rekeyUnder("/a/c/file.ts", "/a/b", "/a/z")).toBeNull();
  });

  it("returns null for a sibling whose name merely shares oldPath as a string prefix", () => {
    expect(rekeyUnder("/a/b/searching/f.ts", "/a/b/search", "/a/b/dst")).toBeNull();
  });

  it("re-addresses the exact oldPath itself (rename target equals source)", () => {
    expect(rekeyUnder("/a/b", "/a/b", "/a/c")).toBe("/a/c");
  });

  it("handles a native Windows path, folding the result to the canonical form", () => {
    expect(rekeyUnder("C:\\ws\\src\\a.ts", "C:\\ws\\src", "C:\\ws\\dst")).toBe("C:/ws/dst/a.ts");
  });
});
