<script lang="ts">
  import { tick } from "svelte";
  import { settingsOverlay, closeSettings } from "../stores/settingsOverlay";
  import { themes } from "../theme/tokens";
  import { themeSelection, setTheme } from "../stores/theme";
  import { terminalPosition, setTerminalPosition, type TerminalPosition } from "../stores/layout";
  import { zoom, zoomIn, zoomOut, resetZoom, MIN_ZOOM, MAX_ZOOM } from "../stores/textSize";
  import { minimapEnabled, setMinimapEnabled } from "../stores/minimapEnabled";
  import { wordWrapEnabled, setWordWrapEnabled } from "../stores/wordWrap";
  import { tabSize, setTabSize, TAB_SIZE_OPTIONS, type TabSize } from "../stores/tabSize";
  import { lineNumbersEnabled, setLineNumbersEnabled } from "../stores/lineNumbersEnabled";
  import { autoSaveEnabled, setAutoSaveEnabled } from "../stores/autoSave";
  import { restoreTabsOnStartup, setRestoreTabsOnStartup } from "../stores/restoreTabsOnStartup";
  import {
    markdownDefaultView,
    setMarkdownDefaultView,
    type MarkdownDefaultView,
  } from "../stores/markdownDefaultView";
  import SettingsSidebar from "../settings/SettingsSidebar.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import Dropdown from "../ui/Dropdown.svelte";
  import { SETTINGS_CATEGORIES, SETTINGS_SECTIONS, sectionMatchesQuery, type SettingsCategoryId } from "../settings/settingsRegistry";

  const THEME_OPTIONS: { id: string; label: string }[] = [
    { id: "auto", label: "Auto" },
    ...themes.map((t) => ({ id: t.id, label: t.name })),
  ];

  const DOCK_POSITIONS: { id: TerminalPosition; label: string }[] = [
    { id: "bottom", label: "Bottom" },
    { id: "left", label: "Left" },
    { id: "right", label: "Right" },
  ];

  const MARKDOWN_VIEW_OPTIONS: { id: MarkdownDefaultView; label: string }[] = [
    { id: "rendered", label: "Rendered" },
    { id: "source", label: "Source" },
  ];

  const TAB_SIZE_DROPDOWN_OPTIONS: { id: string; label: string }[] = TAB_SIZE_OPTIONS.map((size) => ({
    id: String(size),
    label: String(size),
  }));

  const DEFAULT_CATEGORY: SettingsCategoryId = "general";

  let panelEl: HTMLDivElement | undefined = $state();

  // Sidebar selection and search query are transient UI state that resets to
  // defaults every time the dialog opens rather than persisting — see
  // `resetState` below, mirrored by every other Atrium overlay (e.g.
  // `SearchOverlay`) resetting its own transient state the same way.
  let selectedCategory = $state<SettingsCategoryId>(DEFAULT_CATEGORY);
  let searchQuery = $state("");

  function resetState(): void {
    selectedCategory = DEFAULT_CATEGORY;
    searchQuery = "";
  }

  // Same focus-move technique as UnsavedChangesDialog: without moving real
  // keyboard focus into the panel, a genuine Escape keypress stays on
  // whatever was focused before the dialog opened and never reaches the
  // backdrop's keydown handler below.
  $effect(() => {
    if ($settingsOverlay.open) {
      resetState();
      panelEl?.focus();
    }
  });

  let normalizedQuery = $derived(searchQuery.trim().toLowerCase());
  let searching = $derived(normalizedQuery !== "");
  let matchingSectionIds = $derived(
    new Set(SETTINGS_SECTIONS.filter((section) => sectionMatchesQuery(section, normalizedQuery)).map((s) => s.id)),
  );
  let visibleCategories = $derived(
    searching
      ? SETTINGS_CATEGORIES.filter((category) =>
          SETTINGS_SECTIONS.some((section) => section.categoryId === category.id && matchingSectionIds.has(section.id)),
        )
      : SETTINGS_CATEGORIES,
  );
  // The nav's per-category section rows need the same search gate the
  // content pane applies via `isSectionVisible` below — otherwise a section
  // row for a non-matching sibling would stay in the tree, clickable, and
  // resolve to a scroll target `isSectionVisible` has kept out of the DOM.
  let visibleSections = $derived(SETTINGS_SECTIONS.filter((section) => isSectionVisible(section.id)));
  let currentCategoryLabel = $derived(
    SETTINGS_CATEGORIES.find((category) => category.id === selectedCategory)?.label ?? "",
  );

  // While searching, if the currently-selected category no longer has a
  // matching section, jump to the first category that does — mirroring how
  // the sidebar itself hides non-matching categories, so the content pane
  // never sits on an empty, hidden-from-the-sidebar category.
  $effect(() => {
    if (!searching) return;
    const currentHasMatch = SETTINGS_SECTIONS.some(
      (section) => section.categoryId === selectedCategory && matchingSectionIds.has(section.id),
    );
    if (currentHasMatch) return;
    const firstMatch = SETTINGS_CATEGORIES.find((category) =>
      SETTINGS_SECTIONS.some((section) => section.categoryId === category.id && matchingSectionIds.has(section.id)),
    );
    if (firstMatch) selectedCategory = firstMatch.id;
  });

  function isSectionVisible(id: string): boolean {
    return !searching || matchingSectionIds.has(id);
  }

  function sectionAnchorId(id: string): string {
    return `settings-section-${id}`;
  }

  // Clicking (or activating via Enter/Space) a section's nav row switches to
  // its parent category if that isn't already mounted, then scrolls the
  // content pane to it — `block: "nearest"` is what makes "scroll if
  // necessary" literal, since an element already fully in view doesn't move.
  async function scrollToSection(sectionId: string): Promise<void> {
    const section = SETTINGS_SECTIONS.find((s) => s.id === sectionId);
    if (!section) return;
    if (selectedCategory !== section.categoryId) {
      selectedCategory = section.categoryId;
      await tick();
    }
    document.getElementById(sectionAnchorId(sectionId))?.scrollIntoView({ block: "nearest" });
  }

  function onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      closeSettings();
    }
  }
</script>

{#if $settingsOverlay.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="settings-backdrop" onclick={closeSettings} onkeydown={onBackdropKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      bind:this={panelEl}
      class="settings-panel"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
    >
      <div class="settings-header">
        <h2 class="settings-title">Settings</h2>
      </div>

      <div class="settings-body">
        <div class="settings-nav-column">
          <input
            class="settings-search-input"
            type="text"
            bind:value={searchQuery}
            placeholder="Search settings…"
            aria-label="Search settings"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <SettingsSidebar
            categories={visibleCategories}
            sections={visibleSections}
            selected={selectedCategory}
            searching={searching}
            onSelectCategory={(id) => (selectedCategory = id)}
            onSelectSection={(id) => void scrollToSection(id)}
          />
        </div>

        <div class="settings-content" role="region" aria-label={currentCategoryLabel}>
          {#if selectedCategory === "general" && isSectionVisible("zoom")}
            <SettingsSection title="Zoom" id={sectionAnchorId("zoom")}>
              <div class="settings-row">
                <span class="settings-label">Zoom</span>
                <div class="settings-zoom">
                  <button
                    class="settings-zoom-btn"
                    onclick={zoomOut}
                    disabled={$zoom <= MIN_ZOOM}
                    aria-label="Zoom out"
                  >
                    −
                  </button>
                  <span class="settings-zoom-value">{Math.round($zoom * 100)}%</span>
                  <button class="settings-zoom-btn" onclick={zoomIn} disabled={$zoom >= MAX_ZOOM} aria-label="Zoom in">
                    +
                  </button>
                  <button class="settings-btn" onclick={resetZoom}>Reset</button>
                </div>
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "general" && isSectionVisible("restore-tabs-on-startup")}
            <SettingsSection title="Restore Tabs on Startup" id={sectionAnchorId("restore-tabs-on-startup")}>
              <div class="settings-row">
                <span class="settings-label">Restore previously open tabs on startup</span>
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={$restoreTabsOnStartup}
                  onchange={(e) => setRestoreTabsOnStartup(e.currentTarget.checked)}
                  aria-label="Restore previously open tabs on startup"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "appearance" && isSectionVisible("theme")}
            <SettingsSection title="Theme" id={sectionAnchorId("theme")}>
              <div class="settings-row">
                <span class="settings-label">Theme</span>
                <Dropdown options={THEME_OPTIONS} value={$themeSelection} onSelect={setTheme} label="Theme" />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "editor" && isSectionVisible("minimap")}
            <SettingsSection title="Minimap" id={sectionAnchorId("minimap")}>
              <div class="settings-row">
                <span class="settings-label">Show minimap</span>
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={$minimapEnabled}
                  onchange={(e) => setMinimapEnabled(e.currentTarget.checked)}
                  aria-label="Show minimap"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "editor" && isSectionVisible("word-wrap")}
            <SettingsSection title="Word Wrap" id={sectionAnchorId("word-wrap")}>
              <div class="settings-row">
                <span class="settings-label">Wrap long lines</span>
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={$wordWrapEnabled}
                  onchange={(e) => setWordWrapEnabled(e.currentTarget.checked)}
                  aria-label="Wrap long lines"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "editor" && isSectionVisible("tab-size")}
            <SettingsSection title="Tab Size" id={sectionAnchorId("tab-size")}>
              <div class="settings-row">
                <span class="settings-label">Tab size</span>
                <Dropdown
                  options={TAB_SIZE_DROPDOWN_OPTIONS}
                  value={String($tabSize)}
                  onSelect={(id) => setTabSize(Number(id) as TabSize)}
                  label="Tab size"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "editor" && isSectionVisible("line-numbers")}
            <SettingsSection title="Line Numbers" id={sectionAnchorId("line-numbers")}>
              <div class="settings-row">
                <span class="settings-label">Show line numbers</span>
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={$lineNumbersEnabled}
                  onchange={(e) => setLineNumbersEnabled(e.currentTarget.checked)}
                  aria-label="Show line numbers"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "editor" && isSectionVisible("auto-save")}
            <SettingsSection title="Auto Save" id={sectionAnchorId("auto-save")}>
              <div class="settings-row">
                <span class="settings-label">Automatically save changes</span>
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={$autoSaveEnabled}
                  onchange={(e) => setAutoSaveEnabled(e.currentTarget.checked)}
                  aria-label="Automatically save changes"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "markdown" && isSectionVisible("default-view")}
            <SettingsSection title="Default View" id={sectionAnchorId("default-view")}>
              <div class="settings-row">
                <span class="settings-label">Default view for markdown files</span>
                <Dropdown
                  options={MARKDOWN_VIEW_OPTIONS}
                  value={$markdownDefaultView}
                  onSelect={(id) => setMarkdownDefaultView(id as MarkdownDefaultView)}
                  label="Default view for markdown files"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "terminal" && isSectionVisible("dock-position")}
            <SettingsSection title="Dock Position" id={sectionAnchorId("dock-position")}>
              <div class="settings-row">
                <span class="settings-label">Terminal dock position</span>
                <Dropdown
                  options={DOCK_POSITIONS}
                  value={$terminalPosition}
                  onSelect={(id) => setTerminalPosition(id as TerminalPosition)}
                  label="Terminal dock position"
                />
              </div>
            </SettingsSection>
          {/if}

          {#if searching && matchingSectionIds.size === 0}
            <p class="settings-empty">No settings match your search.</p>
          {/if}
        </div>
      </div>

      <div class="settings-actions">
        <button class="settings-btn primary" onclick={closeSettings}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 4000;
  }
  .settings-panel {
    background: var(--atrium-bg-elevated);
    border: 1px solid var(--atrium-border);
    border-radius: 8px;
    width: 680px;
    max-width: 90vw;
    height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    color: var(--atrium-text-primary);
  }
  .settings-header {
    flex-shrink: 0;
    padding: 20px 20px 12px;
  }
  .settings-title {
    margin: 0;
    font-size: 1.1em;
  }
  .settings-body {
    flex: 1;
    min-height: 0;
    display: flex;
    border-top: 1px solid var(--atrium-border);
  }
  .settings-nav-column {
    display: flex;
    flex-direction: column;
    width: 200px;
    flex-shrink: 0;
    border-right: 1px solid var(--atrium-border);
  }
  .settings-search-input {
    flex-shrink: 0;
    box-sizing: border-box;
    margin: 12px 12px 8px;
    padding: 8px 10px;
    font: inherit;
    background: var(--atrium-bg-surface);
    color: inherit;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
  }
  .settings-search-input:focus {
    outline: none;
    border-color: var(--atrium-accent);
  }
  .settings-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 12px 20px;
  }
  .settings-empty {
    color: var(--atrium-text-muted);
    font-size: 0.9em;
    margin: 8px 4px;
  }
  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .settings-label {
    flex-shrink: 0;
  }
  .settings-zoom {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .settings-zoom-btn {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    width: 28px;
    height: 28px;
    line-height: 1;
  }
  .settings-zoom-btn:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-zoom-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .settings-zoom-value {
    min-width: 3.5em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .settings-checkbox {
    width: 16px;
    height: 16px;
    accent-color: var(--atrium-accent);
    cursor: pointer;
  }
  .settings-actions {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    padding: 12px 20px 20px;
  }
  .settings-btn {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 7px 14px;
  }
  .settings-btn:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .settings-btn.primary {
    background: var(--atrium-accent);
    border-color: var(--atrium-accent);
    color: var(--atrium-text-inverse);
  }
</style>
