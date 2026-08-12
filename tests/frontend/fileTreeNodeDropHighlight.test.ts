import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import FileTreeNode from "../../src/lib/explorer/FileTreeNode.svelte";
import { dragOverTargetDir } from "../../src/lib/explorer/explorerDrag";
import type { TreeNode } from "../../src/lib/stores/fileTree";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  localWorkspaceId: () => "local",
  isAppError: (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
}));

const node: TreeNode = {
  entry: { name: "src", path: "C:\\ws\\src", isDir: true, isSymlink: false },
  expanded: false,
  children: undefined,
};

afterEach(() => {
  cleanup();
  dragOverTargetDir.set(null);
});

// The gesture test in `explorerDragMove.test.ts` is POSIX-only. The test below checks the
// highlight against a Windows drag's mix: `dirOf`-normalized `dragOverTargetDir` vs. native `entry.path` (issue #449).
it("highlights a native-separator row when the drop target arrived `/`-normalized", () => {
  dragOverTargetDir.set("C:/ws/src");
  const { container } = render(FileTreeNode, { props: { node } });
  expect(container.querySelector(".row")!.classList.contains("drop-target-active")).toBe(true);
});

it("does not highlight an unrelated row", () => {
  dragOverTargetDir.set("C:/ws/lib");
  const { container } = render(FileTreeNode, { props: { node } });
  expect(container.querySelector(".row")!.classList.contains("drop-target-active")).toBe(false);
});
