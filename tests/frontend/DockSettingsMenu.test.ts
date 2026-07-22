import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import DockSettingsMenu from "../../src/lib/terminal/DockSettingsMenu.svelte";

afterEach(() => {
  cleanup();
});

describe("DockSettingsMenu", () => {
  it("opens the dropdown on click and closes it again on an outside click", async () => {
    const { container } = render(DockSettingsMenu, { position: "bottom", onSetPosition: vi.fn() });

    await fireEvent.click(container.querySelector('button[aria-label="Terminal settings"]')!);
    expect(container.querySelector('[role="menuitemradio"]')).not.toBeNull();

    await fireEvent.click(document.body);
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  it("marks the current dock position as checked", async () => {
    const { container } = render(DockSettingsMenu, { position: "left", onSetPosition: vi.fn() });

    await fireEvent.click(container.querySelector('button[aria-label="Terminal settings"]')!);
    const items = container.querySelectorAll('[role="menuitemradio"]');
    expect(items[0].getAttribute("aria-checked")).toBe("false"); // Bottom
    expect(items[1].getAttribute("aria-checked")).toBe("true"); // Left
    expect(items[2].getAttribute("aria-checked")).toBe("false"); // Right
  });

  it("calls onSetPosition with the chosen position and closes the dropdown", async () => {
    const onSetPosition = vi.fn();
    const { container } = render(DockSettingsMenu, { position: "bottom", onSetPosition });

    await fireEvent.click(container.querySelector('button[aria-label="Terminal settings"]')!);
    const items = container.querySelectorAll('[role="menuitemradio"]');
    await fireEvent.click(items[2]);

    expect(onSetPosition).toHaveBeenCalledWith("right");
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
  });
});
