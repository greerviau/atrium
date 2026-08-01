import { afterEach, describe, expect, it } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import TabDragPreview from "../../src/lib/panes/TabDragPreview.svelte";
import { activeTabDrag } from "../../src/lib/panes/tabDrag";

afterEach(() => {
  cleanup();
  activeTabDrag.set(null);
});

describe("TabDragPreview", () => {
  it("renders the dragged tab beside the pointer", async () => {
    const { container } = render(TabDragPreview);
    activeTabDrag.set({
      key: "pane-1:file.md",
      surface: "editor",
      sourcePaneId: "pane-1",
      path: "/workspace/file.md",
      label: "file.md",
      clientX: 100,
      clientY: 200,
      target: null,
    });
    await tick();

    const preview = container.querySelector(".tab-drag-preview") as HTMLElement;
    expect(preview.textContent).toContain("file.md");
    expect(preview.style.left).toBe("112px");
    expect(preview.style.top).toBe("212px");
  });
});
