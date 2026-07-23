<script lang="ts">
  import ContextMenu from "./ContextMenu.svelte";

  export type DropdownOption = { id: string; label: string };

  /**
   * Generic single-select dropdown built on `ContextMenu`, so its floating
   * panel always matches the active in-app theme rather than the OS's own
   * `<select>` popup chrome. Follows the same self-contained
   * open/close-state + outside-click pattern as `SplitMenu`/`EditorSplitMenu`.
   */
  let {
    options,
    value,
    onSelect,
    label,
  }: {
    options: DropdownOption[];
    value: string;
    onSelect: (id: string) => void;
    label: string;
  } = $props();

  const uid = $props.id();

  let open = $state(false);
  let highlightedIndex = $state(0);
  let rootEl: HTMLDivElement | undefined = $state();
  let triggerEl: HTMLButtonElement | undefined = $state();
  let listboxEl: HTMLDivElement | undefined = $state();

  let selectedIndex = $derived(Math.max(0, options.findIndex((opt) => opt.id === value)));
  let selectedOption = $derived(options[selectedIndex]);
  let activeOptionId = $derived(
    open && options[highlightedIndex] ? `${uid}-option-${options[highlightedIndex].id}` : undefined,
  );

  // Deferred to the next animation frame rather than run directly: `open`
  // flipping true mounts `ContextMenu`, whose own panel stays
  // `visibility: hidden` until *its* positioning effect measures and places
  // it, and a hidden ancestor can't take real focus. Waiting a frame lets
  // that positioning settle first instead of racing it.
  $effect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => listboxEl?.focus());
    return () => cancelAnimationFrame(raf);
  });

  function openMenu(): void {
    highlightedIndex = selectedIndex;
    open = true;
  }

  function closeMenu(): void {
    open = false;
  }

  function choose(id: string): void {
    onSelect(id);
    closeMenu();
    triggerEl?.focus();
  }

  function onTriggerClick(): void {
    if (open) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    if (open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  }

  // Standard ARIA listbox keyboard behavior, adapted from the settings
  // radiogroup's own roving-tabindex arrow key handling: arrow keys (and
  // Home/End) move a highlighted index within the open list, with
  // wraparound, rather than moving real DOM focus among individual options.
  function onListboxKeydown(event: KeyboardEvent): void {
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlightedIndex = (highlightedIndex + 1) % options.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightedIndex = (highlightedIndex - 1 + options.length) % options.length;
    } else if (event.key === "Home") {
      event.preventDefault();
      highlightedIndex = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      highlightedIndex = options.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const opt = options[highlightedIndex];
      if (opt) choose(opt.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      triggerEl?.focus();
    } else if (event.key === "Tab") {
      closeMenu();
    }
  }

  function onWindowClick(event: MouseEvent): void {
    if (!open) return;
    if (rootEl && event.target instanceof Node && rootEl.contains(event.target)) return;
    closeMenu();
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="dropdown" bind:this={rootEl}>
  <button
    type="button"
    class="dropdown-trigger"
    bind:this={triggerEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={label}
    onclick={onTriggerClick}
    onkeydown={onTriggerKeydown}
  >
    <span class="dropdown-trigger-label">{selectedOption?.label ?? ""}</span>
    <span class="dropdown-chevron" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <ContextMenu anchorEl={triggerEl}>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        bind:this={listboxEl}
        class="dropdown-listbox"
        role="listbox"
        aria-label={label}
        aria-activedescendant={activeOptionId}
        tabindex="-1"
        onkeydown={onListboxKeydown}
      >
        {#each options as opt, index (opt.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            id="{uid}-option-{opt.id}"
            class="dropdown-option"
            class:highlighted={index === highlightedIndex}
            role="option"
            aria-selected={opt.id === value}
            tabindex="-1"
            onclick={() => choose(opt.id)}
            onmouseenter={() => (highlightedIndex = index)}
          >
            <span class="dropdown-option-check" aria-hidden="true">{opt.id === value ? "✓" : ""}</span>
            {opt.label}
          </div>
        {/each}
      </div>
    </ContextMenu>
  {/if}
</div>

<style>
  .dropdown {
    display: inline-flex;
  }

  .dropdown-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    font-size: 0.9em;
    cursor: pointer;
    padding: 5px 10px;
  }

  .dropdown-trigger:hover {
    background: var(--atrium-bg-hover);
  }

  .dropdown-chevron {
    font-size: 0.8em;
    opacity: 0.7;
  }

  .dropdown-listbox {
    display: flex;
    flex-direction: column;
    min-width: 160px;
    outline: none;
  }

  .dropdown-option {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 4px;
    white-space: nowrap;
  }

  .dropdown-option:hover,
  .dropdown-option.highlighted {
    background: var(--atrium-bg-hover);
  }

  .dropdown-option[aria-selected="true"] {
    color: var(--atrium-accent);
  }

  .dropdown-option-check {
    width: 1em;
    display: inline-block;
    flex-shrink: 0;
  }
</style>
