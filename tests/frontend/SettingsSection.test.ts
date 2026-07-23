import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import SettingsSectionHost from "./SettingsSectionHost.svelte";

describe("SettingsSection", () => {
  afterEach(() => cleanup());

  it("renders expanded by default, showing its body and aria-expanded=true", () => {
    render(SettingsSectionHost);

    const header = screen.getByRole("button", { name: "Example Section" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Section body content")).toBeTruthy();
  });

  it("clicking the header collapses the body and flips aria-expanded to false", async () => {
    render(SettingsSectionHost);
    const header = screen.getByRole("button", { name: "Example Section" });

    await fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Section body content")).toBeNull();
  });

  it("clicking again re-expands it", async () => {
    render(SettingsSectionHost);
    const header = screen.getByRole("button", { name: "Example Section" });

    await fireEvent.click(header);
    await fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Section body content")).toBeTruthy();
  });

  it("honors a custom title and starts collapsed when initialExpanded is false", () => {
    render(SettingsSectionHost, { props: { title: "Custom", initialExpanded: false } });

    const header = screen.getByRole("button", { name: "Custom" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Section body content")).toBeNull();
  });
});
