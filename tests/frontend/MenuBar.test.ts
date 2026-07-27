import { describe, it, expect, beforeEach, vi } from "vitest";
import { initMenuBar } from "../../src/lib/shell/MenuBar";
import { openExternalLink } from "../../src/lib/ipc/commands";
import { showErrorToast } from "../../src/lib/stores/errorToast";
import { tabsState, notifySaveComplete, notifySaveFailed } from "../../src/lib/stores/tabs";
import type { MenuEventId } from "../../src/lib/ipc/events";

const handlers = new Map<MenuEventId, () => void>();

vi.mock("../../src/lib/ipc/events", () => ({
  onMenuEvent: vi.fn((id: MenuEventId, handler: () => void) => {
    handlers.set(id, handler);
    return Promise.resolve(() => {});
  }),
}));

vi.mock("../../src/lib/ipc/commands", () => ({
  openExternalLink: vi.fn(),
  localWorkspaceId: () => "local",
}));

vi.mock("../../src/lib/stores/errorToast", () => ({
  showErrorToast: vi.fn(),
  describeError: (err: unknown): string => (err instanceof Error ? err.message : "an unknown error"),
}));

describe("MenuBar help links", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.mocked(openExternalLink).mockReset();
    vi.mocked(showErrorToast).mockReset();
    await initMenuBar(
      () => {},
      () => {},
      () => {},
      () => {},
    );
  });

  it("menu:help:github calls showErrorToast when openExternalLink rejects", async () => {
    vi.mocked(openExternalLink).mockRejectedValue(new Error("failed to open URL: no application found"));

    handlers.get("menu:help:github")?.();
    expect(openExternalLink).toHaveBeenCalledWith("https://github.com/greerviau/atrium");

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("failed to open URL"));
  });

  it("menu:help:report-issue calls showErrorToast when openExternalLink rejects", async () => {
    vi.mocked(openExternalLink).mockRejectedValue(new Error("failed to open URL: no application found"));

    handlers.get("menu:help:report-issue")?.();
    expect(openExternalLink).toHaveBeenCalledWith("https://github.com/greerviau/atrium/issues/new");

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("failed to open URL"));
  });

  it("does not call showErrorToast when openExternalLink resolves", async () => {
    vi.mocked(openExternalLink).mockResolvedValue(undefined);

    handlers.get("menu:help:github")?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(showErrorToast).not.toHaveBeenCalled();
  });
});

describe("MenuBar save (issue #250)", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.mocked(showErrorToast).mockReset();
    tabsState.set({ tabs: [], activeTabPath: null });
    await initMenuBar(
      () => {},
      () => {},
      () => {},
      () => {},
    );
  });

  it("calls showErrorToast when the underlying save rejects", async () => {
    tabsState.set({ tabs: [], activeTabPath: "/notes.md" });

    handlers.get("menu:save")?.();
    notifySaveFailed("/notes.md", new Error("permission denied"));
    await new Promise((r) => setTimeout(r, 0));

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
  });

  it("does not call showErrorToast when the save succeeds", async () => {
    tabsState.set({ tabs: [], activeTabPath: "/notes.md" });

    handlers.get("menu:save")?.();
    notifySaveComplete("/notes.md");
    await new Promise((r) => setTimeout(r, 0));

    expect(showErrorToast).not.toHaveBeenCalled();
  });
});

describe("MenuBar split-direction events (issue #156)", () => {
  it("routes each menu:split-* event through onSplitDirection with the right direction", async () => {
    handlers.clear();
    const onSplitDirection = vi.fn();
    await initMenuBar(
      () => {},
      () => {},
      onSplitDirection,
      () => {},
    );

    handlers.get("menu:split-up")?.();
    handlers.get("menu:split-down")?.();
    handlers.get("menu:split-left")?.();
    handlers.get("menu:split-right")?.();

    expect(onSplitDirection).toHaveBeenNthCalledWith(1, "up");
    expect(onSplitDirection).toHaveBeenNthCalledWith(2, "down");
    expect(onSplitDirection).toHaveBeenNthCalledWith(3, "left");
    expect(onSplitDirection).toHaveBeenNthCalledWith(4, "right");
  });

  it("still routes menu:split-terminal through the separate onSplitTerminal callback, not onSplitDirection", async () => {
    handlers.clear();
    const onSplitTerminal = vi.fn();
    const onSplitDirection = vi.fn();
    await initMenuBar(() => {}, onSplitTerminal, onSplitDirection, () => {});

    handlers.get("menu:split-terminal")?.();

    expect(onSplitTerminal).toHaveBeenCalledTimes(1);
    expect(onSplitDirection).not.toHaveBeenCalled();
  });
});

describe("MenuBar close-tab event (issue #279)", () => {
  it("routes menu:close-tab through the onCloseTab callback", async () => {
    handlers.clear();
    const onCloseTab = vi.fn();
    await initMenuBar(
      () => {},
      () => {},
      () => {},
      onCloseTab,
    );

    handlers.get("menu:close-tab")?.();

    expect(onCloseTab).toHaveBeenCalledTimes(1);
  });
});
