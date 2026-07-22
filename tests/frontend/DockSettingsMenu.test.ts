import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import DockSettingsMenu from "../../src/lib/terminal/DockSettingsMenu.svelte";
import { terminalPosition } from "../../src/lib/stores/layout";

beforeEach(() => {
  terminalPosition.set("bottom");
});

afterEach(() => {
  cleanup();
});

describe("DockSettingsMenu", () => {
  it("opens the dropdown on click and closes it again on an outside click", async () => {
    const { container } = render(DockSettingsMenu);

    await fireEvent.click(container.querySelector('button[aria-label="Terminal settings"]')!);
    expect(container.querySelector('[role="menuitemradio"]')).not.toBeNull();

    await fireEvent.click(document.body);
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  it("marks the current dock position (read from the shared store) as checked", async () => {
    terminalPosition.set("left");
    const { container } = render(DockSettingsMenu);

    await fireEvent.click(container.querySelector('button[aria-label="Terminal settings"]')!);
    const items = container.querySelectorAll('[role="menuitemradio"]');
    expect(items[0].getAttribute("aria-checked")).toBe("false"); // Bottom
    expect(items[1].getAttribute("aria-checked")).toBe("true"); // Left
    expect(items[2].getAttribute("aria-checked")).toBe("false"); // Right
  });

  it("sets the shared terminalPosition store when a position is chosen, and closes the dropdown", async () => {
    const { container } = render(DockSettingsMenu);

    await fireEvent.click(container.querySelector('button[aria-label="Terminal settings"]')!);
    const items = container.querySelectorAll('[role="menuitemradio"]');
    await fireEvent.click(items[2]);

    expect(get(terminalPosition)).toBe("right");
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
  });
});
