<script lang="ts">
  import { tick } from "svelte";
  import type { SettingsCategory, SettingsCategoryId, SettingsSectionDef } from "./settingsRegistry";

  let {
    categories,
    sections,
    selected,
    searching = false,
    onSelectCategory,
    onSelectSection,
  }: {
    categories: SettingsCategory[];
    sections: SettingsSectionDef[];
    selected: SettingsCategoryId;
    searching?: boolean;
    onSelectCategory: (id: SettingsCategoryId) => void;
    onSelectSection: (id: string) => void;
  } = $props();

  interface NavRow {
    id: string;
    kind: "category" | "section";
    categoryId: SettingsCategoryId;
    sectionId?: string;
  }

  let treeEl: HTMLDivElement | undefined = $state();

  // Every category starts collapsed (an id absent from this map reads as
  // collapsed) — no init pass over `categories` is needed for that.
  let expandedCategories = $state<Record<string, boolean>>({});

  // While actively searching, every category renders as expanded regardless
  // of its own stored state — the whole point of search is to surface a
  // matching section row no matter which category it lives under, and a
  // collapsed category would otherwise hide it from the nav entirely. This
  // doesn't touch `expandedCategories` itself, so a category's real
  // collapsed/expanded state is exactly as the user left it once the query
  // is cleared.
  function isExpanded(categoryId: string): boolean {
    return searching || (expandedCategories[categoryId] ?? false);
  }

  // Row ids are namespaced (`cat:`/`sec:`) so a category id and a section id
  // can never collide in the single `activeNavId` comparison below, even if
  // the registry ever grows an id pair that would otherwise coincide.
  function categoryRowId(categoryId: string): string {
    return `cat:${categoryId}`;
  }
  function sectionRowId(sectionId: string): string {
    return `sec:${sectionId}`;
  }

  // Expansion-aware flattening of the two-level tree, the same technique
  // `FileTree.svelte`'s `flattenVisible` uses: a category's section rows are
  // only included while that category is expanded, giving arrow-key and
  // Home/End navigation a single ordering to walk.
  let visibleRows = $derived.by(() => {
    const rows: NavRow[] = [];
    for (const category of categories) {
      rows.push({ id: categoryRowId(category.id), kind: "category", categoryId: category.id });
      if (isExpanded(category.id)) {
        for (const section of sections.filter((s) => s.categoryId === category.id)) {
          rows.push({
            id: sectionRowId(section.id),
            kind: "section",
            categoryId: category.id,
            sectionId: section.id,
          });
        }
      }
    }
    return rows;
  });

  // Roving tabindex + arrow-key navigation (WAI-ARIA APG Tree View pattern),
  // mirroring `FileTree.svelte`'s own `focusedPath`/`activePath` split.
  let focusedNavId = $state<string | null>(null);

  // `focusedNavId` can go stale: a search can unmount the row it names (e.g.
  // typing into the search box while a section row holds focus) without
  // anything reconciling it, and every row's own `aria-selected`/`tabindex`
  // key off whichever id this resolves to — a dangling `focusedNavId` would
  // otherwise drop the whole nav out of the tab sequence (every row reading
  // `tabindex="-1"`). Rendering always goes through this derived,
  // guaranteed-valid projection instead of the raw value, falling back to
  // the first visible row. This is `FileTree.svelte:76-87`'s `activePath`,
  // and both `aria-selected` and `tabindex` on every row bind only to this —
  // never to the raw `focusedNavId` — so exactly one row is ever selected
  // and exactly one is ever tabbable.
  let activeNavId = $derived(
    visibleRows.some((row) => row.id === focusedNavId) ? focusedNavId : (visibleRows[0]?.id ?? null),
  );

  function onFocusRow(id: string): void {
    focusedNavId = id;
  }

  async function moveFocusTo(id: string): Promise<void> {
    focusedNavId = id;
    await tick();
    Array.from(treeEl?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
      (el) => el.dataset.rowId === id,
    )?.focus();
  }

  // Selecting a category (its text, or Enter/Space on the row) only ever
  // switches which category's content is mounted — it never touches
  // `expandedCategories`. Expansion is the caret's job alone (`toggleCategory`
  // below, plus ArrowLeft/ArrowRight for keyboard users), so a category can
  // be selected and shown in the content pane while its own nav row stays
  // collapsed with no visible children — a deliberate split, not an
  // oversight: text and disclosure are two different actions on two
  // different controls.
  function selectCategory(categoryId: SettingsCategoryId): void {
    onSelectCategory(categoryId);
  }

  function toggleCategory(categoryId: SettingsCategoryId): void {
    // Toggles the category's own *stored* state, not `isExpanded`'s
    // search-forced effective value — while actively searching, every
    // category reads as expanded regardless of what's actually stored, so
    // toggling off of that read would silently write a wrong
    // collapsed/expanded value that only surfaces once the query clears.
    expandedCategories[categoryId] = !(expandedCategories[categoryId] ?? false);
  }

  // Arrow/Home/End/Enter/Space handling over the flattened row list, matching
  // the WAI-ARIA APG Tree View pattern `FileTree.svelte` already implements
  // for the explorer. That precedent splits this across `FileTree.svelte`'s
  // container-level arrow handling and `FileTreeNode.svelte`'s own per-row
  // Enter/Space handling because it has a recursive child component; this
  // nav has none, so both live in one handler here, delegated from the tree
  // container the same way (`onTreeKeydown` below reads the focused row's id
  // off the bubbled event's target, exactly as `FileTree.svelte`'s
  // `onTreeContainerKeydown` reads `data-path`).
  //
  // This is a deliberate departure from the old tablist's *automatic*
  // activation (where arrowing to a tab immediately selected it): arrow keys
  // here move focus/highlight only, and `Enter`/`Space`/a click is what
  // actually switches category or scrolls to a section — matching
  // `FileTreeNode.svelte:63-64`'s `Enter`/`" "` → `onClick()`.
  function handleRowKeydown(event: KeyboardEvent, id: string): void {
    const index = visibleRows.findIndex((row) => row.id === id);
    if (index === -1) return;
    const row = visibleRows[index];

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = visibleRows[Math.min(index + 1, visibleRows.length - 1)];
      void moveFocusTo(next.id);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = visibleRows[Math.max(index - 1, 0)];
      void moveFocusTo(prev.id);
      return;
    }
    if (event.key === "ArrowRight") {
      if (row.kind !== "category") return;
      event.preventDefault();
      if (!isExpanded(row.categoryId)) {
        expandedCategories[row.categoryId] = true;
        return;
      }
      const next = visibleRows[index + 1];
      if (next?.kind === "section" && next.categoryId === row.categoryId) void moveFocusTo(next.id);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (row.kind === "category" && isExpanded(row.categoryId)) {
        event.preventDefault();
        expandedCategories[row.categoryId] = false;
        return;
      }
      if (row.kind === "category") return;
      event.preventDefault();
      void moveFocusTo(categoryRowId(row.categoryId));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      if (visibleRows.length > 0) void moveFocusTo(visibleRows[0].id);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (visibleRows.length > 0) void moveFocusTo(visibleRows[visibleRows.length - 1].id);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.kind === "category") {
        selectCategory(row.categoryId);
      } else if (row.sectionId) {
        onSelectSection(row.sectionId);
      }
      return;
    }
  }

  function onTreeKeydown(event: KeyboardEvent): void {
    // Resolved by containment, not read directly off the event target's own
    // `dataset` — the caret button nested inside a category row carries no
    // `data-row-id` of its own, so a key pressed while it holds focus (e.g.
    // after a mouse click that focused it) would otherwise be silently
    // dropped, leaving arrow-key expand/collapse dead from that point on.
    const rowId = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    if (rowId === undefined) return;
    handleRowKeydown(event, rowId);
  }
</script>

<div
  class="settings-sidebar"
  bind:this={treeEl}
  role="tree"
  aria-label="Settings categories"
  tabindex="-1"
  onkeydown={onTreeKeydown}
>
  {#each categories as category (category.id)}
    {@const rowId = categoryRowId(category.id)}
    {@const expanded = isExpanded(category.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="settings-nav-row settings-nav-category"
      class:mounted={category.id === selected}
      data-row-id={rowId}
      role="treeitem"
      aria-selected={activeNavId === rowId}
      aria-expanded={expanded}
      aria-level="1"
      tabindex={activeNavId === rowId ? 0 : -1}
      onclick={() => {
        onFocusRow(rowId);
        selectCategory(category.id);
      }}
      onfocus={() => onFocusRow(rowId)}
    >
      <!--
        A real button, not a bare clickable span: it needs its own
        accessible name (the chevron glyph alone means nothing to a screen
        reader) and its own `aria-expanded`, and it must never also select
        the category the way the row's own click does — `stopPropagation`
        keeps the two actions independent even though the button sits
        inside the row.

        `tabindex="-1"`: kept out of the normal Tab sequence rather than
        given its own roving-tabindex slot alongside the row, so Tab still
        visits exactly one stop per visible row, matching the rest of this
        tree. Keyboard users toggle expansion via ArrowRight/ArrowLeft on
        the focused row (already implemented below) rather than tabbing
        into this button — mouse/touch users get a real, generously-sized
        target instead of the 12px glyph alone. This still leans on the row
        keeping its own arrow-key handling reachable even when *this*
        button is what actually holds focus (a real click can focus it,
        engine-dependent, and it's reachable programmatically regardless):
        the click handler calls `onFocusRow` to keep the roving tabindex in
        sync, and `onTreeKeydown` below resolves the acting row via
        `closest("[data-row-id]")` rather than reading the event target's
        own dataset directly, since this button carries none of its own.
      -->
      <button
        type="button"
        class="settings-nav-chevron"
        class:expanded
        aria-expanded={expanded}
        aria-label={expanded ? `Collapse ${category.label}` : `Expand ${category.label}`}
        tabindex="-1"
        onclick={(event) => {
          event.stopPropagation();
          onFocusRow(rowId);
          toggleCategory(category.id);
        }}
      >
        <span aria-hidden="true">▸</span>
      </button>
      {category.label}
    </div>
    {#if isExpanded(category.id)}
      <div role="group">
        {#each sections.filter((s) => s.categoryId === category.id) as section (section.id)}
          {@const secRowId = sectionRowId(section.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="settings-nav-row settings-nav-section"
            data-row-id={secRowId}
            role="treeitem"
            aria-selected={activeNavId === secRowId}
            aria-level="2"
            tabindex={activeNavId === secRowId ? 0 : -1}
            onclick={() => {
              onFocusRow(secRowId);
              onSelectSection(section.id);
            }}
            onfocus={() => onFocusRow(secRowId)}
          >
            {section.title}
          </div>
        {/each}
      </div>
    {/if}
  {/each}
</div>

<style>
  .settings-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-height: 0;
    padding: 4px 8px 12px;
    overflow-y: auto;
  }
  .settings-nav-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    border-radius: 6px;
    cursor: pointer;
    padding: 7px 10px;
  }
  .settings-nav-category {
    /* Explicit rather than left to inherit, so the hierarchy between this
       and .settings-nav-section's own smaller size is a real, visible
       relationship rather than an accident of whatever the ancestor
       happens to set. */
    font-size: 1em;
  }
  .settings-nav-section {
    padding-left: 26px;
    font-size: 0.85em;
  }
  .settings-nav-row:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-nav-row[aria-selected="true"] {
    background: var(--atrium-bg-active);
    color: var(--atrium-accent);
  }
  .settings-nav-category.mounted {
    font-weight: 600;
  }
  .settings-nav-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    margin: -2px;
    background: none;
    border: none;
    border-radius: 4px;
    padding: 0;
    font: inherit;
    font-size: 0.75em;
    color: var(--atrium-text-muted);
    cursor: pointer;
  }
  .settings-nav-chevron:hover {
    background: var(--atrium-bg-active);
    color: var(--atrium-text-primary);
  }
  .settings-nav-chevron:focus-visible {
    outline: 2px solid var(--atrium-accent);
    outline-offset: 1px;
  }
  .settings-nav-chevron span {
    display: inline-flex;
    transition: transform 0.1s ease;
  }
  .settings-nav-chevron.expanded span {
    transform: rotate(90deg);
  }
</style>
