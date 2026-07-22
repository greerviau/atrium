import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import SplitMenu from "../../src/lib/terminal/SplitMenu.svelte";

afterEach(() => {
  cleanup();
});

describe("SplitMenu", () => {
  it("opens the dropdown on click and closes it again on an outside click", async () => {
    const { container } = render(SplitMenu, { onSplit: vi.fn() });

    await fireEvent.click(container.querySelector('button[aria-label="Split terminal"]')!);
    expect(container.querySelector('[role="menuitem"]')).not.toBeNull();

    await fireEvent.click(document.body);
    expect(container.querySelector('[role="menuitem"]')).toBeNull();
  });

  it("calls onSplit with the chosen direction and closes the dropdown", async () => {
    const onSplit = vi.fn();
    const { container } = render(SplitMenu, { onSplit });

    await fireEvent.click(container.querySelector('button[aria-label="Split terminal"]')!);
    const items = container.querySelectorAll('[role="menuitem"]');
    expect([...items].map((el) => el.textContent)).toEqual(["Split Up", "Split Down", "Split Left", "Split Right"]);

    await fireEvent.click(items[2]);
    expect(onSplit).toHaveBeenCalledWith("left");
    expect(container.querySelector('[role="menuitem"]')).toBeNull();
  });
});
