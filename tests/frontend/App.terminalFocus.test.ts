import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";

vi.mock("../../src/lib/explorer/FileTree.svelte", async () => {
  const mod = await import("./FileTreeStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    workspaceTakePendingOpen: vi.fn().mockResolvedValue([]),
    appConfirmClose: vi.fn().mockResolvedValue(undefined),
    ptySpawn: vi.fn().mockResolvedValue("term-1"),
    ptySubscribe: vi.fn().mockResolvedValue(undefined),
    ptyWrite: vi.fn().mockResolvedValue(undefined),
    ptyResize: vi.fn().mockResolvedValue(undefined),
    ptyKill: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList) as typeof window.matchMedia;

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

async function settle(): Promise<void> {
  await tick();
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
});

afterEach(() => {
  cleanup();
});

describe("App terminal focus", () => {
  it("focuses the terminal when opening the panel", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await settle();

    terminalVisible.set(true);
    await settle();

    expect(container.querySelector(".xterm-helper-textarea")).toBe(document.activeElement);
  });

  it("refocuses the terminal when reopening an existing panel", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    terminalVisible.set(true);
    const { container } = render(App);
    await settle();

    const toggle = container.querySelector('button[aria-label^="Toggle Terminal"]')!;
    await fireEvent.click(toggle);
    await settle();
    await fireEvent.click(toggle);
    await settle();

    expect(container.querySelector(".xterm-helper-textarea")).toBe(document.activeElement);
  });
});
