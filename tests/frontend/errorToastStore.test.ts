import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { errorToast, showErrorToast, dismissErrorToast, describeError } from "../../src/lib/stores/errorToast";

describe("errorToast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dismissErrorToast();
  });

  afterEach(() => {
    dismissErrorToast();
    vi.useRealTimers();
  });

  it("showErrorToast sets the message", () => {
    showErrorToast("something failed");
    expect(get(errorToast)).toBe("something failed");
  });

  it("auto-dismisses after ~5s", () => {
    showErrorToast("something failed");
    vi.advanceTimersByTime(4999);
    expect(get(errorToast)).toBe("something failed");

    vi.advanceTimersByTime(1);
    expect(get(errorToast)).toBeNull();
  });

  it("a second call before the timer fires replaces the message and restarts the timer", () => {
    showErrorToast("first failure");
    vi.advanceTimersByTime(4000);

    showErrorToast("second failure");
    expect(get(errorToast)).toBe("second failure");

    // The original timer (would have fired at 5000ms) must not still fire.
    vi.advanceTimersByTime(1000);
    expect(get(errorToast)).toBe("second failure");

    // The restarted timer fires 5000ms after the second call.
    vi.advanceTimersByTime(4000);
    expect(get(errorToast)).toBeNull();
  });

  it("dismissErrorToast clears the store and cancels any pending timer", () => {
    showErrorToast("something failed");
    dismissErrorToast();
    expect(get(errorToast)).toBeNull();

    vi.advanceTimersByTime(10000);
    expect(get(errorToast)).toBeNull();
  });
});

describe("describeError", () => {
  it("extracts the message from an AppError", () => {
    expect(describeError({ code: "invalid_url", message: "refusing to open non-http(s) URL" })).toBe(
      "refusing to open non-http(s) URL",
    );
  });

  it("extracts the message from a native Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("falls back to a generic message for anything else", () => {
    expect(describeError("a plain string")).toBe("an unknown error");
    expect(describeError(undefined)).toBe("an unknown error");
  });
});
