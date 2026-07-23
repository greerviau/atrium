export type SettingsCategoryId = "general" | "appearance" | "editor" | "terminal";

export interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
}

export interface SettingsSectionDef {
  id: string;
  categoryId: SettingsCategoryId;
  title: string;
  keywords: string[];
}

/**
 * The sidebar's category rail, in display order. `SettingsSidebar` and the
 * search filter below both read from this rather than each hardcoding the
 * category list, so adding a category later is a registry entry rather than
 * a change in two places.
 */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
];

/**
 * Every sub-section across all categories, with the search keywords it
 * should match on. `title` is always an implicit match term, so keywords
 * only need to list synonyms not already in the title (e.g. "layout" for
 * Dock Position, since that's the section's pre-redesign name).
 */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "recent-projects",
    categoryId: "general",
    title: "Recent Projects",
    keywords: ["recent", "projects", "clear", "history", "general"],
  },
  {
    id: "theme",
    categoryId: "appearance",
    title: "Theme",
    keywords: ["theme", "appearance", "dark", "light", "auto", "color", "colour"],
  },
  {
    id: "zoom",
    categoryId: "editor",
    title: "Zoom",
    keywords: ["zoom", "text size", "font size", "editor"],
  },
  {
    id: "minimap",
    categoryId: "editor",
    title: "Minimap",
    keywords: ["minimap", "map", "overview", "navigation", "editor"],
  },
  {
    id: "dock-position",
    categoryId: "terminal",
    title: "Dock Position",
    keywords: ["terminal", "dock", "position", "bottom", "left", "right", "layout"],
  },
];

/** Whether `section` matches a already-trimmed, already-lowercased search query. An empty query matches everything. */
export function sectionMatchesQuery(section: SettingsSectionDef, normalizedQuery: string): boolean {
  if (normalizedQuery === "") return true;
  const haystack = `${section.title} ${section.keywords.join(" ")}`.toLowerCase();
  return haystack.includes(normalizedQuery);
}
