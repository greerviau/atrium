import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import ErrorToast from "../../src/lib/shell/ErrorToast.svelte";
import { errorToast, dismissErrorToast } from "../../src/lib/stores/errorToast";

describe("ErrorToast", () => {
  beforeEach(() => {
    dismissErrorToast();
  });

  afterEach(() => {
    cleanup();
    dismissErrorToast();
  });

  it("renders nothing when errorToast is null", () => {
    const { container } = render(ErrorToast);
    expect(container.querySelector(".error-toast")).toBeNull();
  });

  it("renders the message and a dismiss button when set", async () => {
    errorToast.set("Couldn't open link: refusing to open non-http(s) URL");
    render(ErrorToast);
    await tick();

    expect(await screen.findByText(/refusing to open non-http\(s\) URL/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("clicking dismiss clears the store", async () => {
    errorToast.set("something failed");
    render(ErrorToast);
    await tick();

    await fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await tick();

    expect(get(errorToast)).toBeNull();
    expect(screen.queryByText(/something failed/)).toBeNull();
  });
});
