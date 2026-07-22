import { describe, it, expect } from "vitest";
import { folderName, computeTabTitle, reduceTitleState, type TitleState } from "../../src/lib/terminal/tabTitle";

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
  it("returns the folder alone when idle (program: null)", () => {
    expect(
      computeTabTitle({
        cwd: "/Users/greer/github/atrium",
        program: null,
        explicitTitle: null,
        explicitTitleIsFresh: false,
      }),
    ).toBe("atrium");
  });

  it("returns `folder — program` when running with no explicitTitle", () => {
    expect(
      computeTabTitle({
        cwd: "/Users/greer/github/atrium",
        program: "npm",
        explicitTitle: null,
        explicitTitleIsFresh: false,
      }),
    ).toBe("atrium — npm");
  });

  it("returns `folder — explicitTitle` in place of the raw program name when set", () => {
    expect(
      computeTabTitle({
        cwd: "/Users/greer/github/atrium",
        program: "vim",
        explicitTitle: "vim: README.md",
        explicitTitleIsFresh: true,
      }),
    ).toBe("atrium — vim: README.md");
  });

  it("ignores a stale explicitTitle while idle (program: null)", () => {
    expect(
      computeTabTitle({
        cwd: "/Users/greer/github/atrium",
        program: null,
        explicitTitle: "npm",
        explicitTitleIsFresh: false,
      }),
    ).toBe("atrium");
  });
});

describe("reduceTitleState", () => {
  const initial: TitleState = {
    cwd: "/Users/greer/github/atrium",
    program: null,
    explicitTitle: null,
    explicitTitleIsFresh: false,
  };

  it("an explicit title set right after the triggering Enter survives the poller's later backendTitle confirmation", () => {
    // Real ordering: the user hits Enter, the newly-started program sets
    // its own OSC 0/2 title within milliseconds, and only up to a second
    // later does the backend's poll tick confirm the foreground process.
    let state = reduceTitleState(initial, { type: "commandSubmitted" });
    state = reduceTitleState(state, { type: "title", title: "README.md (~/github/atrium) - VIM" });
    state = reduceTitleState(state, { type: "backendTitle", cwd: initial.cwd, program: "vim" });
    expect(computeTabTitle(state)).toBe("atrium — README.md (~/github/atrium) - VIM");
  });

  it("an explicit title set before the triggering Enter (the shell's own idle prompt title) does not bleed into the next program", () => {
    let state = reduceTitleState(initial, { type: "title", title: "atrium — zsh" });
    state = reduceTitleState(state, { type: "commandSubmitted" });
    state = reduceTitleState(state, { type: "backendTitle", cwd: initial.cwd, program: "npm" });
    expect(computeTabTitle(state)).toBe("atrium — npm");
    expect(state.explicitTitle).toBeNull();
  });

  it("a backendTitle transition from a program back to null clears a stale explicitTitle", () => {
    let state = reduceTitleState(initial, { type: "commandSubmitted" });
    state = reduceTitleState(state, { type: "backendTitle", cwd: initial.cwd, program: "npm" });
    state = reduceTitleState(state, { type: "title", title: "npm run dev" });
    state = reduceTitleState(state, { type: "commandSubmitted" });
    state = reduceTitleState(state, { type: "backendTitle", cwd: initial.cwd, program: null });
    expect(state.explicitTitle).toBeNull();
    expect(computeTabTitle(state)).toBe("atrium");
  });

  it("a backendTitle event with the same program leaves explicitTitle untouched", () => {
    let state = reduceTitleState(initial, { type: "commandSubmitted" });
    state = reduceTitleState(state, { type: "backendTitle", cwd: initial.cwd, program: "npm" });
    state = reduceTitleState(state, { type: "title", title: "npm run dev" });
    state = reduceTitleState(state, {
      type: "backendTitle",
      cwd: "/Users/greer/github/wingman",
      program: "npm",
    });
    expect(computeTabTitle(state)).toBe("wingman — npm run dev");
  });

  it("cwd updates independently of program/explicitTitle state", () => {
    let state = reduceTitleState(initial, { type: "commandSubmitted" });
    state = reduceTitleState(state, { type: "backendTitle", cwd: initial.cwd, program: "npm" });
    state = reduceTitleState(state, {
      type: "backendTitle",
      cwd: "/Users/greer/github/wingman",
      program: "npm",
    });
    expect(computeTabTitle(state)).toBe("wingman — npm");
  });
});
