import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import ImagePane from "../../src/lib/editor/ImagePane.svelte";
import { onFsChanged, type FsChangeEvent } from "../../src/lib/ipc/events";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol: string) => `${protocol}://${path}`,
}));

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn(),
}));

let fsChangeHandler: ((event: FsChangeEvent) => void) | undefined;
const unlisten = vi.fn();

describe("ImagePane", () => {
  beforeEach(() => {
    fsChangeHandler = undefined;
    unlisten.mockReset();
    vi.mocked(onFsChanged).mockReset().mockImplementation((handler) => {
      fsChangeHandler = handler;
      return Promise.resolve(unlisten);
    });
  });

  afterEach(() => cleanup());

  it("renders the image through the scoped Atrium asset protocol", () => {
    const { getByRole } = render(ImagePane, {
      filePath: "/workspace/My Photo.png",
      workspaceId: "local",
    });

    const image = getByRole("img", { name: "My Photo.png" });
    expect(image.getAttribute("src")).toBe("atriumasset:///workspace/My Photo.png?revision=0");
  });

  it("shows a load error, then retries with a cache-busting URL when the file changes", async () => {
    const { getByRole, queryByRole } = render(ImagePane, {
      filePath: "/workspace/photo.png",
      workspaceId: "local",
    });
    const image = getByRole("img", { name: "photo.png" });
    await waitFor(() => expect(fsChangeHandler).toBeDefined());

    await fireEvent.error(image);
    expect(getByRole("alert").textContent).toContain("Couldn’t display photo.png");

    fsChangeHandler?.({ workspaceId: "local", path: "/workspace/photo.png", kind: "modify" });
    await tick();

    expect(queryByRole("alert")).toBeNull();
    expect(image.getAttribute("src")).toBe("atriumasset:///workspace/photo.png?revision=1");
  });

  it("ignores changes for other paths and workspaces", async () => {
    const { getByRole } = render(ImagePane, {
      filePath: "/workspace/photo.png",
      workspaceId: "local",
    });
    const image = getByRole("img", { name: "photo.png" });
    await waitFor(() => expect(fsChangeHandler).toBeDefined());

    fsChangeHandler?.({ workspaceId: "local", path: "/workspace/other.png", kind: "modify" });
    fsChangeHandler?.({ workspaceId: "standalone", path: "/workspace/photo.png", kind: "modify" });
    await tick();

    expect(image.getAttribute("src")).toBe("atriumasset:///workspace/photo.png?revision=0");
  });
});
