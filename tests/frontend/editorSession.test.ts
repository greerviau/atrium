import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadEditorSession,
  saveEditorSession,
  flushEditorSession,
  reconcileRestoredSession,
  restoreEditorSession,
  type PersistedEditorSession,
} from "../../src/lib/stores/editorSession";
import type { EditorLeafPane, EditorPaneNode, EditorSplitPane } from "../../src/lib/editor/editorPaneTree";
import { markdownDefaultView, DEFAULT_MARKDOWN_VIEW } from "../../src/lib/stores/markdownDefaultView";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsCheckFileAccess: vi.fn(),
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

  it("flushEditorSession writes a pending save immediately instead of waiting out the debounce", () => {
    saveEditorSession("/proj", { paneTree: leaf("L1", ["/proj/a.txt"]), focusedPaneId: "L1" });
    flushEditorSession("/proj");

    expect(loadEditorSession("/proj")).toEqual({ paneTree: leaf("L1", ["/proj/a.txt"]), focusedPaneId: "L1" });

    // The timer it flushed doesn't fire again later and overwrite anything.
    vi.advanceTimersByTime(400);
    expect(loadEditorSession("/proj")).toEqual({ paneTree: leaf("L1", ["/proj/a.txt"]), focusedPaneId: "L1" });
  });

  it("flushEditorSession is a no-op when nothing is pending for that root", () => {
    expect(() => flushEditorSession("/proj")).not.toThrow();
    expect(loadEditorSession("/proj")).toBeNull();
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

// Windows path-canonicalization plan, §4.3 migration: a session persisted
// under the pre-fix storage key (built from the raw, native-separator root)
// must still be found, its paths folded to the canonical form before they
// re-enter the identity space, and the next save must land under the new
// canonical key rather than perpetuating the legacy one.
describe("legacy storage key fallback and path canonicalization on restore", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds a session persisted under the pre-canonicalization (raw backslash) key", () => {
    const legacySession = { paneTree: leaf("L1", ["C:\\ws\\a.md"]), focusedPaneId: "L1" };
    localStorage.setItem("atrium.editorSession.C:\\ws", JSON.stringify(legacySession));

    expect(loadEditorSession("C:\\ws")).not.toBeNull();
  });

  it("canonicalizes every persisted path on restore, even read through the legacy key", () => {
    const legacySession = {
      paneTree: leaf("L1", ["C:\\ws\\a.md", "C:\\ws\\b.md"], "C:\\ws\\b.md"),
      focusedPaneId: "L1",
    };
    localStorage.setItem("atrium.editorSession.C:\\ws", JSON.stringify(legacySession));

    const loaded = loadEditorSession("C:\\ws");

    expect((loaded!.paneTree as EditorLeafPane).tabs).toEqual(["C:/ws/a.md", "C:/ws/b.md"]);
    expect((loaded!.paneTree as EditorLeafPane).activeTabPath).toBe("C:/ws/b.md");
  });

  it("prefers the canonical key over the legacy key when both exist", () => {
    localStorage.setItem(
      "atrium.editorSession.C:\\ws",
      JSON.stringify({ paneTree: leaf("L1", ["stale"]), focusedPaneId: "L1" }),
    );
    localStorage.setItem(
      "atrium.editorSession.C:/ws",
      JSON.stringify({ paneTree: leaf("L1", ["fresh"]), focusedPaneId: "L1" }),
    );

    const loaded = loadEditorSession("C:\\ws");

    expect((loaded!.paneTree as EditorLeafPane).tabs).toEqual(["fresh"]);
  });

  it("the next save writes under the canonical key, leaving the legacy key as a dead, unread entry", () => {
    localStorage.setItem(
      "atrium.editorSession.C:\\ws",
      JSON.stringify({ paneTree: leaf("L1", ["C:\\ws\\a.md"]), focusedPaneId: "L1" }),
    );

    saveEditorSession("C:\\ws", { paneTree: leaf("L1", ["C:/ws/a.md"]), focusedPaneId: "L1" });
    vi.advanceTimersByTime(400);

    expect(localStorage.getItem("atrium.editorSession.C:/ws")).not.toBeNull();
    // The legacy key is never deleted, only shadowed — harmless, since the
    // canonical key is always consulted first.
    expect(loadEditorSession("C:\\ws")).toEqual({ paneTree: leaf("L1", ["C:/ws/a.md"]), focusedPaneId: "L1" });
  });
});

describe("reconcileRestoredSession", () => {
  beforeEach(() => {
    markdownDefaultView.set(DEFAULT_MARKDOWN_VIEW);
  });

  it("returns an empty session when nothing was persisted (null paneTree)", () => {
    const result = reconcileRestoredSession({ paneTree: null, focusedPaneId: null }, new Map());
    expect(result).toEqual({ tabs: [], activeTabPath: null, paneTree: null, focusedPaneId: null });
  });

  // Proves §3.2's "reordering rides the existing save path for free" claim
  // directly, rather than asserting it: a deliberately non-alphabetical,
  // non-insertion order (c, a, b — what a user-driven drag reorder would
  // produce) must survive the reconcile step verbatim. `reconcileRestoredSession`
  // rebuilds `tabs` from a `Set` built by iterating `leaf.tabs` itself (not
  // `readable`'s own insertion order), so a bug that switched to iterating
  // `readable` instead would silently reorder to whatever order the paths
  // happened to be read off disk in.
  it("preserves a reordered (non-alphabetical) leaf.tabs order through the reconcile step", () => {
    const session: PersistedEditorSession = {
      paneTree: leaf("L1", ["/proj/c.ts", "/proj/a.ts", "/proj/b.ts"], "/proj/c.ts"),
      focusedPaneId: "L1",
    };
    const readable = new Map([
      ["/proj/a.ts", "const a = 1;"],
      ["/proj/b.ts", "const b = 1;"],
      ["/proj/c.ts", "const c = 1;"],
    ]);

    const result = reconcileRestoredSession(session, readable);

    expect(result.paneTree).toEqual(leaf("L1", ["/proj/c.ts", "/proj/a.ts", "/proj/b.ts"], "/proj/c.ts"));
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

  it("rebuilds an image tab without text contents", () => {
    const session: PersistedEditorSession = {
      paneTree: leaf("L1", ["/proj/photo.webp"], "/proj/photo.webp"),
      focusedPaneId: "L1",
    };
    const readable = new Map([["/proj/photo.webp", ""]]);

    const result = reconcileRestoredSession(session, readable);

    expect(result.tabs[0]).toMatchObject({
      path: "/proj/photo.webp",
      mode: "image",
      savedDoc: "",
      isDirty: false,
    });
  });

  it("restores a markdown tab honoring the current markdownDefaultView setting, not a hardcoded default", () => {
    markdownDefaultView.set("source");
    const session: PersistedEditorSession = {
      paneTree: leaf("L1", ["/proj/a.md"], "/proj/a.md"),
      focusedPaneId: "L1",
    };
    const readable = new Map([["/proj/a.md", "# a"]]);

    const result = reconcileRestoredSession(session, readable);

    expect(result.tabs.find((t) => t.path === "/proj/a.md")?.viewMode).toBe("source");
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
    vi.mocked(commands.fsCheckFileAccess).mockReset().mockResolvedValue(undefined);
    vi.mocked(commands.fsReadFile).mockReset();
  });

  it("returns null when nothing was persisted for the root", async () => {
    expect(await restoreEditorSession("/proj")).toBeNull();
    expect(commands.fsReadFile).not.toHaveBeenCalled();
  });

  it("re-reads every referenced path fresh off disk and returns the reconciled session", async () => {
    localStorage.setItem(
      "atrium.editorSession./proj",
      JSON.stringify({ paneTree: leaf("L1", ["/proj/a.txt"], "/proj/a.txt"), focusedPaneId: "L1" }),
    );
    vi.mocked(commands.fsReadFile).mockResolvedValue("disk contents");

    const result = await restoreEditorSession("/proj");

    expect(result?.tabs).toEqual([
      expect.objectContaining({ path: "/proj/a.txt", savedDoc: "disk contents", isDirty: false }),
    ]);
    expect(result?.activeTabPath).toBe("/proj/a.txt");
    expect(result?.paneTree).toEqual(leaf("L1", ["/proj/a.txt"], "/proj/a.txt"));
    expect(result?.focusedPaneId).toBe("L1");
    expect(commands.fsReadFile).toHaveBeenCalledWith("local", "/proj/a.txt");
  });

  it("validates a persisted image without reading it as UTF-8", async () => {
    localStorage.setItem(
      "atrium.editorSession./proj",
      JSON.stringify({ paneTree: leaf("L1", ["/proj/photo.avif"], "/proj/photo.avif"), focusedPaneId: "L1" }),
    );

    const result = await restoreEditorSession("/proj");

    expect(result?.tabs[0]).toMatchObject({ path: "/proj/photo.avif", mode: "image", savedDoc: "" });
    expect(commands.fsCheckFileAccess).toHaveBeenCalledWith("local", "/proj/photo.avif");
    expect(commands.fsReadFile).not.toHaveBeenCalled();
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

    const result = await restoreEditorSession("/proj");

    expect(result?.tabs.map((t) => t.path)).toEqual(["/proj/a.txt"]);
    expect(result?.paneTree).toEqual(leaf("L1", ["/proj/a.txt"], "/proj/a.txt"));
  });

  it("silently drops a persisted external tab whose read fails with INVALID_PATH, keeping the ordinary paths (which are required for this assertion to mean anything — a session containing only the failing path would restore nothing either way, vacuously)", async () => {
    localStorage.setItem(
      "atrium.editorSession./proj",
      JSON.stringify({
        paneTree: leaf("L1", ["/proj/a.txt", "/home/alice/outside.md"], "/proj/a.txt"),
        focusedPaneId: "L1",
      }),
    );
    vi.mocked(commands.fsReadFile).mockImplementation(async (_ws, path: string) => {
      if (path === "/home/alice/outside.md") {
        throw { code: "INVALID_PATH", message: "path '/home/alice/outside.md' escapes the workspace root" };
      }
      return "kept contents";
    });

    const result = await restoreEditorSession("/proj");

    expect(result?.tabs.map((t) => t.path)).toEqual(["/proj/a.txt"]);
    expect(result?.paneTree).toEqual(leaf("L1", ["/proj/a.txt"], "/proj/a.txt"));
  });

  it("returns null and logs instead of throwing on an unexpected non-AppError failure", async () => {
    localStorage.setItem(
      "atrium.editorSession./proj",
      JSON.stringify({ paneTree: leaf("L1", ["/proj/a.txt"], "/proj/a.txt"), focusedPaneId: "L1" }),
    );
    vi.mocked(commands.fsReadFile).mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(restoreEditorSession("/proj")).resolves.toBeNull();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
