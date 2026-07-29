import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import { mockWindows, mockIPC, clearMocks } from "@tauri-apps/api/mocks";

// The real registry (post content-pass) leaves every category with exactly
// one section, so it can't exercise the nav's per-section search filter — a
// category surviving the category-level filter while one of its own several
// sections doesn't match. This stubs a synthetic two-section category to
// cover that case, the same way `FileTreeKeyboardNav.test.ts` stubs the IPC
// module it needs but the real one doesn't provide a fixture for.
vi.mock("../../src/lib/settings/settingsRegistry", () => {
  const SETTINGS_CATEGORIES = [{ id: "general", label: "General" }];
  const SETTINGS_SECTIONS = [
    { id: "alpha", categoryId: "general", title: "Alpha", keywords: ["aaa"] },
    { id: "beta", categoryId: "general", title: "Beta", keywords: ["bbb"] },
  ];
  function sectionMatchesQuery(
    section: { title: string; keywords: string[] },
    normalizedQuery: string,
  ): boolean {
    if (normalizedQuery === "") return true;
    const haystack = `${section.title} ${section.keywords.join(" ")}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  }
  return { SETTINGS_CATEGORIES, SETTINGS_SECTIONS, sectionMatchesQuery };
});

import SettingsDialog from "../../src/lib/shell/SettingsDialog.svelte";
import { settingsOverlay } from "../../src/lib/stores/settingsOverlay";

describe("SettingsDialog search filters section nav rows (synthetic multi-section fixture)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindows("main");
    mockIPC(() => null);
    settingsOverlay.set({ open: false });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    clearMocks();
  });

  it("keeps only the matching section row in the nav when one of a category's several sections doesn't match a search", async () => {
    settingsOverlay.set({ open: true });
    render(SettingsDialog);
    await tick();

    const searchInput = screen.getByLabelText("Search settings");

    // Every category starts collapsed; while actively searching every
    // category renders expanded regardless, so a query matching both
    // sections ("a" is a substring of both "alpha aaa" and "beta bbb")
    // surfaces both without needing to expand anything by hand first.
    await fireEvent.input(searchInput, { target: { value: "a" } });
    await tick();

    expect(screen.getByRole("treeitem", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Beta" })).toBeTruthy();

    await fireEvent.input(searchInput, { target: { value: "aaa" } });
    await tick();

    expect(screen.getByRole("treeitem", { name: "Alpha" })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: "Beta" })).toBeNull();
  });
});
