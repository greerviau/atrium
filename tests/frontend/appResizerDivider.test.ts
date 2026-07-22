import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { explorerVisible, terminalVisible, terminalPosition } from "../../src/lib/stores/layout";

vi.mock("../../src/lib/explorer/FileTree.svelte", async () => {
  const mod = await import("./FileTreeStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    workspaceTakePendingOpen: vi.fn().mockResolvedValue(null),
    appConfirmClose: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  explorerVisible.set(true);
  terminalVisible.set(true);
  terminalPosition.set("bottom");
}

function collectComponentCss(): string {
  return [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
}

describe("App resizer divider (#130)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a .resizer-line child inside both the explorer/editor and editor/terminal resizers", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    const { container } = render(App);
    await tick();
    await tick();

    const resizers = container.querySelectorAll(".resizer");
    expect(resizers).toHaveLength(2);
    for (const resizer of resizers) {
      expect(resizer.querySelectorAll(".resizer-line")).toHaveLength(1);
    }

    const explorerResizer = container.querySelector(".resizer.vertical:not(.horizontal)");
    expect(explorerResizer).not.toBeNull();
  });

  it.each([
    ["bottom", "horizontal"],
    ["left", "vertical"],
    ["right", "vertical"],
  ] as const)("editor/terminal resizer picks up .%s orientation when dock position is %s", async (position, expectedClass) => {
    workspace.set({ id: "local", root: "/projects/demo" });
    terminalPosition.set(position);

    const { container } = render(App);
    await tick();
    await tick();

    const terminalAreaResizer = container.querySelector(".main .resizer");
    expect(terminalAreaResizer).not.toBeNull();
    expect(terminalAreaResizer!.classList.contains(expectedClass)).toBe(true);
    expect(terminalAreaResizer!.querySelectorAll(".resizer-line")).toHaveLength(1);
  });

  it("ships a .resizer-line rule colored from --atrium-border, never transparent", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    render(App);
    await tick();

    const css = collectComponentCss();
    // Scoped-class-tolerant: Svelte appends a `svelte-<hash>` class to every
    // selector, so match up to the next `{` rather than an exact selector.
    const baseRuleMatch = css.match(/\.resizer-line[^{,]*\{([^}]*)\}/);
    expect(baseRuleMatch).not.toBeNull();
    const baseRule = baseRuleMatch![1];
    expect(baseRule).toMatch(/background:\s*var\(--atrium-border\)/);
    expect(baseRule).not.toMatch(/transparent/);
  });

  it("ships a :hover/:active rule that highlights the line with --atrium-accent", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    render(App);
    await tick();

    const css = collectComponentCss();
    const hoverRuleMatch = css.match(/\.resizer[^{]*:hover[^{]*\.resizer-line[^{]*\{([^}]*)\}/);
    expect(hoverRuleMatch).not.toBeNull();
    expect(hoverRuleMatch![1]).toMatch(/background:\s*var\(--atrium-accent\)/);

    const activeRuleMatch = css.match(/\.resizer[^{]*:active[^{]*\.resizer-line[^{]*\{([^}]*)\}/);
    expect(activeRuleMatch).not.toBeNull();
    expect(activeRuleMatch![1]).toMatch(/background:\s*var\(--atrium-accent\)/);
  });

  it("does not double up the explorer/editor divider with .explorer's own border", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    render(App);
    await tick();

    const css = collectComponentCss();
    const explorerRuleMatch = css.match(/\.explorer[^{,]*\{([^}]*)\}/);
    expect(explorerRuleMatch).not.toBeNull();
    expect(explorerRuleMatch![1]).not.toMatch(/border-right/);
  });
});
