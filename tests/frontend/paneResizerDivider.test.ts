import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import PaneSplit from "../../src/lib/terminal/PaneSplit.svelte";
import type { PaneNode } from "../../src/lib/terminal/paneTree";
import { mountLog } from "./mountLog";

vi.mock("../../src/lib/terminal/TerminalPanel.svelte", async () => {
  const mod = await import("./TerminalPanelStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
  mountLog.length = 0;
});

function leafNode(id: string) {
  return { type: "leaf" as const, id, tabs: [{ id: `${id}-tab`, cwd: "/proj", title: "proj" }], activeTabId: `${id}-tab` };
}

const SPLIT: PaneNode = {
  type: "split",
  id: "s1",
  direction: "row",
  children: [leafNode("p1"), leafNode("p2")],
  sizes: [0.5, 0.5],
};

function noop(): void {
  // used as an inert callback prop where the test doesn't assert on it
}

const baseProps = {
  activePaneId: "p1",
  workspaceId: "local",
  onFocus: noop,
  onSplit: noop,
  onClose: noop,
  onNewTab: noop,
  onCloseTab: noop,
  onSessionExit: noop,
  onSetActiveTab: noop,
  onTitleChange: noop,
  onResizeSplit: noop,
};

function collectComponentCss(): string {
  return [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
}

describe("pane-resizer divider (#124)", () => {
  it("renders a .pane-resizer-line child inside the resizer, at every boundary", () => {
    const { container } = render(PaneSplit, { tree: SPLIT, hasSplits: true, ...baseProps });

    const resizer = container.querySelector(".pane-resizer")!;
    expect(resizer.querySelectorAll(".pane-resizer-line")).toHaveLength(1);
  });

  it("ships a .pane-resizer-line rule colored from --atrium-border, never transparent", () => {
    render(PaneSplit, { tree: SPLIT, hasSplits: true, ...baseProps });

    const css = collectComponentCss();
    // Scoped-class-tolerant: Svelte appends a `svelte-<hash>` class to every
    // selector, so match up to the next `{` rather than an exact selector.
    const baseRuleMatch = css.match(/\.pane-resizer-line[^{,]*\{([^}]*)\}/);
    expect(baseRuleMatch).not.toBeNull();
    const baseRule = baseRuleMatch![1];
    expect(baseRule).toMatch(/background:\s*var\(--atrium-border\)/);
    expect(baseRule).not.toMatch(/transparent/);
  });

  it("ships a :hover/:active rule that highlights the line with --atrium-accent", () => {
    render(PaneSplit, { tree: SPLIT, hasSplits: true, ...baseProps });

    const css = collectComponentCss();
    const hoverRuleMatch = css.match(/\.pane-resizer[^{]*:hover[^{]*\.pane-resizer-line[^{]*\{([^}]*)\}/);
    expect(hoverRuleMatch).not.toBeNull();
    expect(hoverRuleMatch![1]).toMatch(/background:\s*var\(--atrium-accent\)/);

    const activeRuleMatch = css.match(/\.pane-resizer[^{]*:active[^{]*\.pane-resizer-line[^{]*\{([^}]*)\}/);
    expect(activeRuleMatch).not.toBeNull();
    expect(activeRuleMatch![1]).toMatch(/background:\s*var\(--atrium-accent\)/);
  });
});
