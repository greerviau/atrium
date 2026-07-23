import { describe, it, expect, beforeEach, vi } from "vitest";
import { initMenuBar } from "../../src/lib/shell/MenuBar";
import { openExternalLink } from "../../src/lib/ipc/commands";
import { showErrorToast } from "../../src/lib/stores/errorToast";
import type { MenuEventId } from "../../src/lib/ipc/events";

const handlers = new Map<MenuEventId, () => void>();

vi.mock("../../src/lib/ipc/events", () => ({
  onMenuEvent: vi.fn((id: MenuEventId, handler: () => void) => {
    handlers.set(id, handler);
    return Promise.resolve(() => {});
  }),
}));

vi.mock("../../src/lib/ipc/commands", () => ({
  openExternalLink: vi.fn(),
  localWorkspaceId: () => "local",
}));

vi.mock("../../src/lib/stores/errorToast", () => ({
  showErrorToast: vi.fn(),
  describeError: (err: unknown): string => (err instanceof Error ? err.message : "an unknown error"),
}));

describe("MenuBar help links", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.mocked(openExternalLink).mockReset();
    vi.mocked(showErrorToast).mockReset();
    await initMenuBar(
      () => {},
      () => {},
    );
  });

  it("menu:help:github calls showErrorToast when openExternalLink rejects", async () => {
    vi.mocked(openExternalLink).mockRejectedValue(new Error("failed to open URL: no application found"));

    handlers.get("menu:help:github")?.();
    expect(openExternalLink).toHaveBeenCalledWith("https://github.com/greerviau/atrium");

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("failed to open URL"));
  });

  it("menu:help:report-issue calls showErrorToast when openExternalLink rejects", async () => {
    vi.mocked(openExternalLink).mockRejectedValue(new Error("failed to open URL: no application found"));

    handlers.get("menu:help:report-issue")?.();
    expect(openExternalLink).toHaveBeenCalledWith("https://github.com/greerviau/atrium/issues/new");

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("failed to open URL"));
  });

  it("does not call showErrorToast when openExternalLink resolves", async () => {
    vi.mocked(openExternalLink).mockResolvedValue(undefined);

    handlers.get("menu:help:github")?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(showErrorToast).not.toHaveBeenCalled();
  });
});
