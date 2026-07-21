import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import UnsavedChangesDialog from "../../src/lib/shell/UnsavedChangesDialog.svelte";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import { tabsState, saveRequest, notifySaveComplete, type Tab } from "../../src/lib/stores/tabs";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsWriteFile: vi.fn(),
  localWorkspaceId: () => "local",
  appConfirmClose: vi.fn(),
}));

function dirtyTab(path: string): Tab {
  return {
    path,
    mode: "code",
    savedDoc: "",
    isDirty: true,
    hasExternalConflict: false,
  };
}

/**
 * Stands in for the `EditorPane` that normally owns `saveRequest`: writes
 * the file via the (mocked) `fsWriteFile` and resolves the pending
 * `requestSave` promise, mirroring `EditorPane.svelte`'s own `saveRequest`
 * effect (`notifySaveComplete` once the save settles).
 */
function actAsEditorPane(): () => void {
  return saveRequest.subscribe((path) => {
    if (path === null) return;
    void commands.fsWriteFile("local", path, "").then(() => {
      saveRequest.set(null);
      notifySaveComplete(path);
    });
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await tick();
}

describe("UnsavedChangesDialog", () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.fsWriteFile).mockResolvedValue(undefined);
    vi.mocked(commands.appConfirmClose).mockResolvedValue(undefined);
    tabsState.set({ tabs: [], activeTabPath: null });
    closePrompt.set(null);
    saveRequest.set(null);
    unsubscribe = actAsEditorPane();
  });

  afterEach(() => {
    cleanup();
    unsubscribe();
  });

  it("renders nothing until a prompt is set", () => {
    const { container } = render(UnsavedChangesDialog);
    expect(container.querySelector(".close-prompt-panel")).toBeNull();
  });

  describe("kind: tab", () => {
    beforeEach(() => {
      tabsState.set({ tabs: [dirtyTab("/notes.md")], activeTabPath: "/notes.md" });
      closePrompt.set({ kind: "tab", path: "/notes.md" });
    });

    it("shows the filename in the confirmation message", async () => {
      render(UnsavedChangesDialog);
      await tick();

      expect(await screen.findByText(/notes\.md/)).toBeTruthy();
    });

    it("Save writes the file, then removes the tab and closes the prompt", async () => {
      render(UnsavedChangesDialog);
      await tick();

      await fireEvent.click(screen.getByText("Save"));
      await flush();

      expect(commands.fsWriteFile).toHaveBeenCalledWith("local", "/notes.md", "");
      expect(get(tabsState).tabs).toHaveLength(0);
      expect(get(closePrompt)).toBeNull();
    });

    it("Don't Save removes the tab without writing the file", async () => {
      render(UnsavedChangesDialog);
      await tick();

      await fireEvent.click(screen.getByText("Don't Save"));
      await flush();

      expect(commands.fsWriteFile).not.toHaveBeenCalled();
      expect(get(tabsState).tabs).toHaveLength(0);
      expect(get(closePrompt)).toBeNull();
    });

    it("Cancel leaves the tab and its isDirty flag untouched", async () => {
      render(UnsavedChangesDialog);
      await tick();

      await fireEvent.click(screen.getByText("Cancel"));
      await flush();

      expect(commands.fsWriteFile).not.toHaveBeenCalled();
      expect(get(tabsState).tabs).toHaveLength(1);
      expect(get(tabsState).tabs[0].isDirty).toBe(true);
      expect(get(closePrompt)).toBeNull();
    });

    it("Escape cancels without closing the tab", async () => {
      const { container } = render(UnsavedChangesDialog);
      await tick();

      const backdrop = container.querySelector(".close-prompt-backdrop")!;
      await fireEvent.keyDown(backdrop, { key: "Escape" });
      await flush();

      expect(get(tabsState).tabs).toHaveLength(1);
      expect(get(closePrompt)).toBeNull();
    });
  });

  describe("kind: window", () => {
    beforeEach(() => {
      tabsState.set({
        tabs: [dirtyTab("/a.md"), dirtyTab("/b.md")],
        activeTabPath: "/a.md",
      });
      closePrompt.set({ kind: "window", paths: ["/a.md", "/b.md"] });
    });

    it("lists every affected file in the confirmation message", async () => {
      render(UnsavedChangesDialog);
      await tick();

      expect(await screen.findByText(/a\.md.*b\.md/)).toBeTruthy();
    });

    it("Save All writes every listed file before appConfirmClose is invoked", async () => {
      render(UnsavedChangesDialog);
      await tick();

      await fireEvent.click(screen.getByText("Save All"));
      await flush();
      await flush();

      expect(commands.fsWriteFile).toHaveBeenCalledWith("local", "/a.md", "");
      expect(commands.fsWriteFile).toHaveBeenCalledWith("local", "/b.md", "");
      expect(commands.appConfirmClose).toHaveBeenCalledTimes(1);
      expect(get(closePrompt)).toBeNull();
    });

    it("Don't Save invokes appConfirmClose directly, writing no file", async () => {
      render(UnsavedChangesDialog);
      await tick();

      await fireEvent.click(screen.getByText("Don't Save"));
      await flush();

      expect(commands.fsWriteFile).not.toHaveBeenCalled();
      expect(commands.appConfirmClose).toHaveBeenCalledTimes(1);
      expect(get(closePrompt)).toBeNull();
    });

    it("Cancel invokes neither fsWriteFile nor appConfirmClose", async () => {
      render(UnsavedChangesDialog);
      await tick();

      await fireEvent.click(screen.getByText("Cancel"));
      await flush();

      expect(commands.fsWriteFile).not.toHaveBeenCalled();
      expect(commands.appConfirmClose).not.toHaveBeenCalled();
      expect(get(closePrompt)).toBeNull();
    });
  });
});
