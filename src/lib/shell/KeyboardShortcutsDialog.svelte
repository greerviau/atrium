<script lang="ts">
  import { shortcutsOverlay, closeShortcuts } from "../stores/shortcutsOverlay";
  import { SHORTCUT_LABELS } from "./shortcutLabels";

  interface ShortcutRow {
    label: string;
    keys: string;
  }

  interface ShortcutGroup {
    title: string;
    rows: ShortcutRow[];
  }

  // Static, hand-maintained mirror of `main.rs`'s `build_menu` accelerators
  // (plus the one shortcut — Shift+Enter in the terminal — that has no menu
  // entry at all). Nothing in the frontend has access to Rust's accelerator
  // strings, so keep this in sync by hand whenever `build_menu` changes one.
  // The four rows also shown as a `StatusBar.svelte` button tooltip read
  // their glyph from `shortcutLabels.ts` instead of repeating it here.
  const SHORTCUT_GROUPS: ShortcutGroup[] = [
    { title: "General", rows: [{ label: "Settings", keys: SHORTCUT_LABELS.settings }] },
    {
      title: "File",
      rows: [
        { label: "Open Folder", keys: "⌘O" },
        { label: "Save", keys: "⌘S" },
        { label: "New Terminal Tab", keys: "⌘T" },
      ],
    },
    {
      title: "Edit",
      rows: [
        { label: "Find in Files", keys: SHORTCUT_LABELS.findInFiles },
        { label: "Go to File", keys: SHORTCUT_LABELS.goToFile },
      ],
    },
    {
      title: "View",
      rows: [
        { label: "Toggle File Explorer", keys: SHORTCUT_LABELS.toggleExplorer },
        { label: "Toggle Terminal", keys: SHORTCUT_LABELS.toggleTerminal },
        { label: "Split Terminal", keys: "⌘\\" },
        { label: "Zoom In", keys: "⌘=" },
        { label: "Zoom Out", keys: "⌘−" },
        { label: "Reset Zoom", keys: "⌘0" },
      ],
    },
    {
      title: "Terminal",
      rows: [{ label: "Insert Newline Without Submitting", keys: "⇧⏎" }],
    },
  ];

  let panelEl: HTMLDivElement | undefined = $state();

  // Same focus-move technique as SettingsDialog/UnsavedChangesDialog: without
  // moving real keyboard focus into the panel, a genuine Escape keypress
  // stays on whatever was focused before the dialog opened and never reaches
  // the backdrop's keydown handler below.
  $effect(() => {
    if ($shortcutsOverlay.open) {
      panelEl?.focus();
    }
  });

  function onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      closeShortcuts();
    }
  }
</script>

{#if $shortcutsOverlay.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="shortcuts-backdrop" onclick={closeShortcuts} onkeydown={onBackdropKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      bind:this={panelEl}
      class="shortcuts-panel"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts"
      tabindex="-1"
    >
      <h2 class="shortcuts-title">Keyboard Shortcuts</h2>

      {#each SHORTCUT_GROUPS as group (group.title)}
        <section class="shortcuts-section">
          <h3 class="shortcuts-section-title">{group.title}</h3>
          {#each group.rows as row (row.label)}
            <div class="shortcuts-row">
              <span class="shortcuts-label">{row.label}</span>
              <kbd class="shortcuts-keys">{row.keys}</kbd>
            </div>
          {/each}
        </section>
      {/each}

      <div class="shortcuts-actions">
        <button class="shortcuts-btn primary" onclick={closeShortcuts}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .shortcuts-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 4000;
  }
  .shortcuts-panel {
    background: var(--atrium-bg-elevated);
    border: 1px solid var(--atrium-border);
    border-radius: 8px;
    width: 480px;
    max-width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
    padding: 20px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    color: var(--atrium-text-primary);
  }
  .shortcuts-title {
    margin: 0 0 16px;
    font-size: 1.1em;
  }
  .shortcuts-section {
    margin-bottom: 18px;
  }
  .shortcuts-section-title {
    margin: 0 0 8px;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--atrium-text-muted);
  }
  .shortcuts-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
  }
  .shortcuts-label {
    flex-shrink: 0;
  }
  .shortcuts-keys {
    background: var(--atrium-bg-hover);
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    padding: 2px 8px;
    font-family: inherit;
    font-size: 0.9em;
  }
  .shortcuts-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .shortcuts-btn {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 7px 14px;
  }
  .shortcuts-btn:hover {
    background: var(--atrium-bg-hover);
  }
  .shortcuts-btn.primary {
    background: var(--atrium-accent);
    border-color: var(--atrium-accent);
    color: var(--atrium-text-inverse);
  }
</style>
