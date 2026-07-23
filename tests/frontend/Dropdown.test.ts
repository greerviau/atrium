import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import Dropdown from "../../src/lib/ui/Dropdown.svelte";

const OPTIONS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
];

afterEach(() => {
  cleanup();
});

function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector(".dropdown-trigger") as HTMLButtonElement;
}

function options(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[role="option"]')] as HTMLElement[];
}

describe("Dropdown", () => {
  it("renders closed by default, showing the selected option's label", () => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "b", onSelect: vi.fn(), label: "Example" });

    expect(trigger(container).textContent).toContain("Bravo");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking the trigger opens the listbox, showing every option with the current one selected", async () => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "b", onSelect: vi.fn(), label: "Example" });

    await fireEvent.click(trigger(container));

    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    const rows = options(container);
    expect(rows.map((r) => r.textContent?.trim())).toEqual(["Alpha", "✓ Bravo", "Charlie"]);
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
    expect(rows[2].getAttribute("aria-selected")).toBe("false");
  });

  it("clicking an option calls onSelect with its id and closes the dropdown", async () => {
    const onSelect = vi.fn();
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect, label: "Example" });

    await fireEvent.click(trigger(container));
    await fireEvent.click(options(container)[2]);

    expect(onSelect).toHaveBeenCalledWith("c");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("ArrowDown moves the highlighted option forward, wrapping past the last one", async () => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect: vi.fn(), label: "Example" });
    await fireEvent.click(trigger(container));

    const listbox = container.querySelector('[role="listbox"]')!;
    expect(options(container)[0].classList.contains("highlighted")).toBe(true);

    await fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options(container)[1].classList.contains("highlighted")).toBe(true);

    await fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options(container)[2].classList.contains("highlighted")).toBe(true);

    await fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options(container)[0].classList.contains("highlighted")).toBe(true);
  });

  it("ArrowUp from the first option wraps around to the last", async () => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect: vi.fn(), label: "Example" });
    await fireEvent.click(trigger(container));

    const listbox = container.querySelector('[role="listbox"]')!;
    await fireEvent.keyDown(listbox, { key: "ArrowUp" });

    expect(options(container)[2].classList.contains("highlighted")).toBe(true);
  });

  it("Enter selects the highlighted option and closes the dropdown", async () => {
    const onSelect = vi.fn();
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect, label: "Example" });
    await fireEvent.click(trigger(container));

    const listbox = container.querySelector('[role="listbox"]')!;
    await fireEvent.keyDown(listbox, { key: "ArrowDown" });
    await fireEvent.keyDown(listbox, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("b");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("Escape closes the dropdown without selecting, returning focus to the trigger", async () => {
    const onSelect = vi.fn();
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect, label: "Example" });
    await fireEvent.click(trigger(container));

    const listbox = container.querySelector('[role="listbox"]')!;
    await fireEvent.keyDown(listbox, { key: "ArrowDown" });
    await fireEvent.keyDown(listbox, { key: "Escape" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(container));
  });

  it("ArrowDown on the closed trigger opens the dropdown with the selected option highlighted", async () => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "b", onSelect: vi.fn(), label: "Example" });

    await fireEvent.keyDown(trigger(container), { key: "ArrowDown" });

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(options(container)[1].classList.contains("highlighted")).toBe(true);
  });

  it.each(["Enter", " "])("%s on the closed trigger also opens the dropdown", async (key) => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect: vi.fn(), label: "Example" });

    await fireEvent.keyDown(trigger(container), { key });

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("exposes the highlighted option to assistive tech via aria-activedescendant", async () => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect: vi.fn(), label: "Example" });
    await fireEvent.click(trigger(container));

    const listbox = container.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options(container)[0].id);

    await fireEvent.keyDown(listbox, { key: "ArrowDown" });

    expect(listbox.getAttribute("aria-activedescendant")).toBe(options(container)[1].id);
  });

  it("closes when clicking outside the dropdown", async () => {
    const { container } = render(Dropdown, { options: OPTIONS, value: "a", onSelect: vi.fn(), label: "Example" });
    await fireEvent.click(trigger(container));
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    await fireEvent.click(document.body);

    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
