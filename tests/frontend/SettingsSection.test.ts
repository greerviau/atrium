import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/svelte";
import SettingsSectionHost from "./SettingsSectionHost.svelte";

describe("SettingsSection", () => {
  afterEach(() => cleanup());

  it("renders its title and children", () => {
    const { container } = render(SettingsSectionHost);

    expect(screen.getByRole("heading", { name: "Example Section" })).toBeTruthy();
    expect(screen.getByText("Section body content")).toBeTruthy();
    expect(container.querySelector("#example-section")).not.toBeNull();
  });

  it("honors a custom title", () => {
    render(SettingsSectionHost, { props: { title: "Custom" } });

    expect(screen.getByRole("heading", { name: "Custom" })).toBeTruthy();
  });
});
