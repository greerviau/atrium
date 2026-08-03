<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { tabsState, setActiveTab } from "../stores/tabs";
  import { standaloneWorkspaceId } from "../ipc/commands";
  import { revealInFinder } from "../ipc/reveal";
  import { basename } from "../util/path";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { attachScrollbarAutoHide } from "../ui/scrollbarAutoHide";
  import { contiguousPathSelection } from "./rangeSelection";

  // The single-file-workspace explorer (issue #325): unlike `FileTree`,
  // there is no directory to list — every row here is one of the standalone
  // tabs already open in `tabsState`, in tab order. Deliberately reads only
  // from state the frontend already holds: no `fs_list_dir` call anywhere
  // in this file, matching `StandaloneWorkspace`'s own root-less design on
  // the Rust side (see its module doc comment) — fabricating a directory
  // listing here would reintroduce exactly the boundary this component
  // exists to respect.

  let listEl: HTMLDivElement;
  let detach: (() => void) | undefined;

  onMount(() => {
    detach = attachScrollbarAutoHide(listEl);
  });
  onDestroy(() => detach?.());

  let rows = $derived($tabsState.tabs.filter((t) => t.workspaceId === standaloneWorkspaceId()));

  // Roving tabindex, mirroring the single-level subset of FileTree's own
  // keyboard/ARIA semantics (#333): no expand/collapse, since there is
  // nothing to expand.
  let focusedPath = $state<string | null>(null);
  let activePath = $derived(
    rows.some((r) => r.path === focusedPath) ? focusedPath : (rows[0]?.path ?? null),
  );
  // Range selection follows tab order. Arrow navigation and unmodified clicks
  // collapse the selection to one row.
  let selectionAnchorPath = $state<string | null>(null);
  let explicitSelectedPaths = $state<Set<string>>(new Set());
  let selectedPaths = $derived.by(() => {
    const visiblePaths = new Set(rows.map((row) => row.path));
    const selected = new Set([...explicitSelectedPaths].filter((path) => visiblePaths.has(path)));
    if (selected.size > 0) return selected;
    return activePath === null ? new Set<string>() : new Set([activePath]);
  });

  function onFocusRow(path: string): void {
    focusedPath = path;
  }

  function activate(path: string): void {
    setActiveTab(path);
  }

  function selectRow(path: string, extendSelection: boolean): void {
    const anchorPath = selectionAnchorPath ?? activePath;
    focusedPath = path;
    if (!extendSelection) {
      selectionAnchorPath = path;
      explicitSelectedPaths = new Set([path]);
      activate(path);
      return;
    }

    const visiblePaths = rows.map((row) => row.path);
    explicitSelectedPaths = contiguousPathSelection(visiblePaths, anchorPath, path);
    selectionAnchorPath = anchorPath !== null && visiblePaths.includes(anchorPath) ? anchorPath : path;
  }

  async function moveFocusTo(path: string): Promise<void> {
    focusedPath = path;
    selectionAnchorPath = path;
    explicitSelectedPaths = new Set([path]);
    await tick();
    Array.from(listEl.querySelectorAll<HTMLElement>(".row[data-path]")).find((row) => row.dataset.path === path)?.focus();
  }

  function onRowKeydown(event: KeyboardEvent, path: string): void {
    const index = rows.findIndex((r) => r.path === path);
    if (index === -1) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      void moveFocusTo(rows[Math.min(index + 1, rows.length - 1)].path);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      void moveFocusTo(rows[Math.max(index - 1, 0)].path);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      if (rows.length > 0) void moveFocusTo(rows[0].path);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (rows.length > 0) void moveFocusTo(rows[rows.length - 1].path);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(path);
      return;
    }
  }

  let contextMenu = $state<{ x: number; y: number; path: string } | null>(null);

  function onRowContextMenu(event: MouseEvent, path: string): void {
    event.preventDefault();
    contextMenu = { x: event.clientX, y: event.clientY, path };
  }

  function closeContextMenu(): void {
    contextMenu = null;
  }

  async function reveal(path: string): Promise<void> {
    closeContextMenu();
    await revealInFinder(path);
  }
</script>

<svelte:window onclick={closeContextMenu} />

<div class="standalone-file-list" bind:this={listEl}>
  <div role="tree" aria-label="Open Files" aria-multiselectable="true">
    {#each rows as row (row.path)}
      <div
        class="row"
        data-path={row.path}
        title={row.path}
        role="treeitem"
        aria-selected={selectedPaths.has(row.path)}
        aria-level="1"
        tabindex={activePath === row.path ? 0 : -1}
        onclick={(event) => selectRow(row.path, event.shiftKey)}
        onkeydown={(event) => onRowKeydown(event, row.path)}
        oncontextmenu={(event) => onRowContextMenu(event, row.path)}
        onfocus={() => onFocusRow(row.path)}
      >
        <span class="name">{basename(row.path)}</span>
      </div>
    {/each}
  </div>
</div>

{#if contextMenu}
  {@const menuPath = contextMenu.path}
  <ContextMenu x={contextMenu.x} y={contextMenu.y}>
    <button role="menuitem" onclick={() => void reveal(menuPath)}>Reveal in Finder</button>
  </ContextMenu>
{/if}

<style>
  .standalone-file-list {
    height: 100%;
    overflow: auto;
    font-size: 0.9em;
    padding: 6px 0;
    -webkit-user-select: none;
    user-select: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    cursor: pointer;
    white-space: nowrap;
    -webkit-user-select: none;
    user-select: none;
  }
  .row:hover {
    background: var(--atrium-bg-hover);
  }
  .row[aria-selected="true"] {
    background: var(--atrium-selection-bg);
  }
  /* Plain `:focus`, not `:focus-visible` — matches `FileTreeNode.svelte`'s
     own row styling, since this row is just as much a keyboard target
     (Up/Down/Home/End, Enter/Space) regardless of how focus arrived. */
  .row:focus {
    outline: 1px solid var(--atrium-accent);
    outline-offset: -1px;
    background: var(--atrium-selection-bg);
  }
</style>
