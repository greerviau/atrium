<script lang="ts">
  import { tick } from "svelte";
  import type { SettingsCategory, SettingsCategoryId, SettingsSectionDef } from "./settingsRegistry";

  let {
    categories,
    sections,
    selected,
    onSelectCategory,
    onSelectSection,
  }: {
    categories: SettingsCategory[];
    sections: SettingsSectionDef[];
    selected: SettingsCategoryId;
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

  // Every category starts expanded (an id absent from this map reads as
  // expanded), matching today's "everything visible, nothing hidden by
  // default" feel — no init pass over `categories` is needed for that.
  let expandedCategories = $state<Record<string, boolean>>({});

  function isExpanded(categoryId: string): boolean {
    return expandedCategories[categoryId] ?? true;
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

  function activateCategory(categoryId: SettingsCategoryId): void {
    // A category header both toggles its own expansion and activates it
    // (switches which category's content is mounted) in one action,
    // consistent with how a click already did both under the old tablist.
    expandedCategories[categoryId] = !isExpanded(categoryId);
    onSelectCategory(categoryId);
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
        activateCategory(row.categoryId);
      } else if (row.sectionId) {
        onSelectSection(row.sectionId);
      }
      return;
    }
  }

  function onTreeKeydown(event: KeyboardEvent): void {
    const rowId = (event.target as HTMLElement | null)?.dataset.rowId;
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
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="settings-nav-row settings-nav-category"
      class:mounted={category.id === selected}
      data-row-id={rowId}
      role="treeitem"
      aria-selected={activeNavId === rowId}
      aria-expanded={isExpanded(category.id)}
      aria-level="1"
      tabindex={activeNavId === rowId ? 0 : -1}
      onclick={() => {
        onFocusRow(rowId);
        activateCategory(category.id);
      }}
      onfocus={() => onFocusRow(rowId)}
    >
      <span class="settings-nav-chevron" class:expanded={isExpanded(category.id)} aria-hidden="true">▸</span>
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
  .settings-nav-section {
    padding-left: 26px;
    font-size: 0.95em;
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
    font-size: 0.75em;
    color: var(--atrium-text-muted);
    transition: transform 0.1s ease;
  }
  .settings-nav-chevron.expanded {
    transform: rotate(90deg);
  }
</style>
