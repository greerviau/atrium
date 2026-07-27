import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  loadEditorSession,
  saveEditorSession,
  reconcileRestoredSession,
  restoreEditorSession,
  type PersistedEditorSession,
} from "../../src/lib/stores/editorSession";
import { tabsState } from "../../src/lib/stores/tabs";
import { editorPaneTree, focusedEditorPaneId } from "../../src/lib/stores/editorPanes";
import type { EditorLeafPane, EditorPaneNode, EditorSplitPane } from "../../src/lib/editor/editorPaneTree";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsReadFile: vi.fn(),
  localWorkspaceId: () => "local",
  isAppError: (value: unknown): value is { code: string; message: string } =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
}));

function leaf(id: string, tabs: string[], activeTabPath: string | null = tabs[tabs.length - 1] ?? null): EditorLeafPane {
  return { type: "leaf", id, tabs, activeTabPath };
}

function split(id: string, children: EditorPaneNode[], sizes: number[]): EditorSplitPane {
  return { type: "split", id, direction: "row", children, sizes };
}

describe("loadEditorSession / saveEditorSession", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for a workspace with nothing persisted", () => {
    expect(loadEditorSession("/proj")).toBeNull();
  });

  it("round-trips a saved session after the debounce elapses", () => {
    const session: PersistedEditorSession = {
      paneTree: leaf("L1", ["/proj/a.txt"]),
      focusedPaneId: "L1",
    };
    saveEditorSession("/proj", session);
    vi.advanceTimersByTime(400);

    expect(loadEditorSession("/proj")).toEqual(session);
  });

  it("debounces rapid writes, persisting only the last one after the quiet period elapses", () => {
    saveEditorSession("/proj", { paneTree: leaf("L1", ["/proj/a.txt"]), focusedPaneId: "L1" });
    vi.advanceTimersByTime(100);
    saveEditorSession("/proj", { paneTree: leaf("L1", ["/proj/b.txt"]), focusedPaneId: "L1" });
    vi.advanceTimersByTime(100);
    saveEditorSession("/proj", { paneTree: leaf("L1", ["/proj/c.txt"]), focusedPaneId: "L1" });

    // Each call resets the debounce window, so 200ms after the last call
    // (still short of the 400ms window) nothing has been written yet.
    vi.advanceTimersByTime(200);
    expect(loadEditorSession("/proj")).toBeNull();

    vi.advanceTimersByTime(200);
    expect(loadEditorSession("/proj")).toEqual({ paneTree: leaf("L1", ["/proj/c.txt"]), focusedPaneId: "L1" });
  });

  it("keeps each workspace root's session separate", () => {
    saveEditorSession("/proj-a", { paneTree: leaf("L1", ["/proj-a/a.txt"]), focusedPaneId: "L1" });
    saveEditorSession("/proj-b", { paneTree: leaf("L2", ["/proj-b/b.txt"]), focusedPaneId: "L2" });
    vi.advanceTimersByTime(400);

    expect(loadEditorSession("/proj-a")).toEqual({ paneTree: leaf("L1", ["/proj-a/a.txt"]), focusedPaneId: "L1" });
    expect(loadEditorSession("/proj-b")).toEqual({ paneTree: leaf("L2", ["/proj-b/b.txt"]), focusedPaneId: "L2" });
  });

  it("tolerates corrupted localStorage content instead of throwing", () => {
    localStorage.setItem("atrium.editorSession./proj", "not json");
    expect(loadEditorSession("/proj")).toBeNull();
  });

  it("returns null for a malformed session shape (e.g. a split with mismatched sizes/children length)", () => {
    const malformed = { paneTree: { type: "split", id: "s", direction: "row", children: [leaf("L1", [])], sizes: [0.5, 0.5] }, focusedPaneId: null };
    localStorage.setItem("atrium.editorSession./proj", JSON.stringify(malformed));
    expect(loadEditorSession("/proj")).toBeNull();
  });

  it("returns null when a leaf's tabs array holds a non-string entry", () => {
    const malformed = { paneTree: { type: "leaf", id: "L1", tabs: [1, 2], activeTabPath: null }, focusedPaneId: null };
    localStorage.setItem("atrium.editorSession./proj", JSON.stringify(malformed));
    expect(loadEditorSession("/proj")).toBeNull();
  });

  it("swallows a write error instead of throwing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => {
      saveEditorSession("/proj", { paneTree: null, focusedPaneId: null });
      vi.advanceTimersByTime(400);
    }).not.toThrow();
    setItem.mockRestore();
  });
});

describe("reconcileRestoredSession", () => {
  it("returns an empty session when nothing was persisted (null paneTree)", () => {
    const result = reconcileRestoredSession({ paneTree: null, focusedPaneId: null }, new Map());
    expect(result).toEqual({ tabs: [], activeTabPath: null, paneTree: null, focusedPaneId: null });
  });

  it("rebuilds tabs and keeps the tree intact when every path is readable", () => {
    const session: PersistedEditorSession = {
      paneTree: leaf("L1", ["/proj/a.md", "/proj/b.ts"], "/proj/b.ts"),
      focusedPaneId: "L1",
    };
    const readable = new Map([
      ["/proj/a.md", "# a"],
      ["/proj/b.ts", "const b = 1;"],
    ]);

    const result = reconcileRestoredSession(session, readable);

    expect(result.paneTree).toEqual(leaf("L1", ["/proj/a.md", "/proj/b.ts"], "/proj/b.ts"));
    expect(result.focusedPaneId).toBe("L1");
    expect(result.activeTabPath).toBe("/proj/b.ts");
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs.find((t) => t.path === "/proj/a.md")).toMatchObject({
      path: "/proj/a.md",
      mode: "markdown",
      savedDoc: "# a",
      isDirty: false,
      viewMode: "rendered",
    });
    expect(result.tabs.find((t) => t.path === "/proj/b.ts")).toMatchObject({
      path: "/proj/b.ts",
      mode: "code",
      savedDoc: "const b = 1;",
      isDirty: false,
      viewMode: undefined,
    });
  });

  it("drops a path missing from `readable` (e.g. deleted while the app was closed), pruning it from its leaf", () => {
    const session: PersistedEditorSession = {
      paneTree: leaf("L1", ["/proj/a.txt", "/proj/gone.txt"], "/proj/gone.txt"),
      focusedPaneId: "L1",
    };
    const readable = new Map([["/proj/a.txt", "kept"]]);

    const result = reconcileRestoredSession(session, readable);

    expect(result.paneTree).toEqual(leaf("L1", ["/proj/a.txt"], "/proj/a.txt"));
    expect(result.tabs.map((t) => t.path)).toEqual(["/proj/a.txt"]);
    expect(result.activeTabPath).toBe("/proj/a.txt");
  });

  it("collapses a leaf entirely, and the whole tree to null, when every path in it is missing", () => {
    const session: PersistedEditorSession = {
      paneTree: leaf("L1", ["/proj/gone.txt"], "/proj/gone.txt"),
      focusedPaneId: "L1",
    };

    const result = reconcileRestoredSession(session, new Map());

    expect(result.paneTree).toBeNull();
    expect(result.tabs).toEqual([]);
    expect(result.focusedPaneId).toBeNull();
    expect(result.activeTabPath).toBeNull();
  });

  it("falls back focusedPaneId to the tree's first remaining leaf when the persisted focused leaf was pruned away", () => {
    const session: PersistedEditorSession = {
      paneTree: split("s", [leaf("L1", ["/proj/a.txt"]), leaf("L2", ["/proj/gone.txt"])], [0.5, 0.5]),
      focusedPaneId: "L2",
    };
    const readable = new Map([["/proj/a.txt", "kept"]]);

    const result = reconcileRestoredSession(session, readable);

    expect(result.paneTree).toEqual(leaf("L1", ["/proj/a.txt"]));
    expect(result.focusedPaneId).toBe("L1");
    expect(result.activeTabPath).toBe("/proj/a.txt");
  });

  it("only reconstructs each distinct path once even if it's open in more than one leaf", () => {
    const session: PersistedEditorSession = {
      paneTree: split("s", [leaf("L1", ["/proj/shared.txt"]), leaf("L2", ["/proj/shared.txt"])], [0.5, 0.5]),
      focusedPaneId: "L1",
    };
    const readable = new Map([["/proj/shared.txt", "content"]]);

    const result = reconcileRestoredSession(session, readable);

    expect(result.tabs).toHaveLength(1);
  });
});

describe("restoreEditorSession", () => {
  beforeEach(() => {
    localStorage.clear();
    tabsState.set({ tabs: [], activeTabPath: null });
    editorPaneTree.set(null);
    focusedEditorPaneId.set(null);
    vi.mocked(commands.fsReadFile).mockReset();
  });

  it("is a no-op when nothing was persisted for the root", async () => {
    await restoreEditorSession("/proj");

    expect(get(tabsState)).toEqual({ tabs: [], activeTabPath: null });
    expect(get(editorPaneTree)).toBeNull();
    expect(get(focusedEditorPaneId)).toBeNull();
  });

  it("re-reads every referenced path fresh off disk and applies tabsState before editorPaneTree", async () => {
    localStorage.setItem(
      "atrium.editorSession./proj",
      JSON.stringify({ paneTree: leaf("L1", ["/proj/a.txt"], "/proj/a.txt"), focusedPaneId: "L1" }),
    );
    vi.mocked(commands.fsReadFile).mockResolvedValue("disk contents");

    await restoreEditorSession("/proj");

    expect(get(tabsState).tabs).toEqual([
      expect.objectContaining({ path: "/proj/a.txt", savedDoc: "disk contents", isDirty: false }),
    ]);
    expect(get(tabsState).activeTabPath).toBe("/proj/a.txt");
    expect(get(editorPaneTree)).toEqual(leaf("L1", ["/proj/a.txt"], "/proj/a.txt"));
    expect(get(focusedEditorPaneId)).toBe("L1");
  });

  it("silently drops a path whose read fails with NOT_FOUND", async () => {
    localStorage.setItem(
      "atrium.editorSession./proj",
      JSON.stringify({
        paneTree: leaf("L1", ["/proj/a.txt", "/proj/deleted.txt"], "/proj/deleted.txt"),
        focusedPaneId: "L1",
      }),
    );
    vi.mocked(commands.fsReadFile).mockImplementation(async (_ws, path: string) => {
      if (path === "/proj/deleted.txt") throw { code: "NOT_FOUND", message: "not found" };
      return "kept contents";
    });

    await restoreEditorSession("/proj");

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/proj/a.txt"]);
    expect(get(editorPaneTree)).toEqual(leaf("L1", ["/proj/a.txt"], "/proj/a.txt"));
  });

  it("leaves state untouched and logs instead of throwing on an unexpected non-AppError failure", async () => {
    localStorage.setItem(
      "atrium.editorSession./proj",
      JSON.stringify({ paneTree: leaf("L1", ["/proj/a.txt"], "/proj/a.txt"), focusedPaneId: "L1" }),
    );
    vi.mocked(commands.fsReadFile).mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(restoreEditorSession("/proj")).resolves.toBeUndefined();

    expect(get(tabsState)).toEqual({ tabs: [], activeTabPath: null });
    expect(get(editorPaneTree)).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
