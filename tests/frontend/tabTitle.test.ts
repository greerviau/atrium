import { describe, it, expect } from "vitest";
import { parseOsc7Cwd, folderName, computeTabTitle } from "../../src/lib/terminal/tabTitle";

describe("parseOsc7Cwd", () => {
  it("parses a well-formed file:// URL with a hostname", () => {
    expect(parseOsc7Cwd("file://hostname/Users/greer/github/atrium")).toBe(
      "/Users/greer/github/atrium",
    );
  });

  it("decodes a percent-encoded path", () => {
    expect(parseOsc7Cwd("file://hostname/Users/greer/My%20Projects/caf%C3%A9")).toBe(
      "/Users/greer/My Projects/café",
    );
  });

  it("parses a payload with no hostname", () => {
    expect(parseOsc7Cwd("file:///path/to/dir")).toBe("/path/to/dir");
  });

  it("returns null for a non-file:// URL", () => {
    expect(parseOsc7Cwd("https://example.com/path")).toBeNull();
  });

  it("returns null for input that isn't a URL at all", () => {
    expect(parseOsc7Cwd("not a url")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseOsc7Cwd("")).toBeNull();
  });
});

describe("folderName", () => {
  it("returns the last segment of a multi-segment path", () => {
    expect(folderName("/Users/greer/github/atrium")).toBe("atrium");
  });

  it("strips a trailing slash before taking the last segment", () => {
    expect(folderName("/Users/greer/github/atrium/")).toBe("atrium");
  });

  it("falls back to the full path for the root path", () => {
    expect(folderName("/")).toBe("/");
  });

  it("returns the segment for a single-segment path", () => {
    expect(folderName("/atrium")).toBe("atrium");
  });
});

describe("computeTabTitle", () => {
  it("returns the folder alone when idle, regardless of a stale processTitle", () => {
    expect(
      computeTabTitle({ cwd: "/Users/greer/github/atrium", commandRunning: false, processTitle: "npm" }),
    ).toBe("atrium");
  });

  it("returns `folder — processTitle` when a command is running and has a title", () => {
    expect(
      computeTabTitle({ cwd: "/Users/greer/github/atrium", commandRunning: true, processTitle: "npm" }),
    ).toBe("atrium — npm");
  });

  it("returns the folder alone when running but the command hasn't set a title yet", () => {
    expect(
      computeTabTitle({ cwd: "/Users/greer/github/atrium", commandRunning: true, processTitle: null }),
    ).toBe("atrium");
  });
});
