<script lang="ts">
  import { settingsOverlay, closeSettings } from "../stores/settingsOverlay";
  import { themes } from "../theme/tokens";
  import { themeSelection, setTheme } from "../stores/theme";
  import { terminalPosition, setTerminalPosition, type TerminalPosition } from "../stores/layout";
  import { zoom, zoomIn, zoomOut, resetZoom } from "../stores/textSize";
  import { workspaceClearRecents, isAppError } from "../ipc/commands";

  const DOCK_POSITIONS: { id: TerminalPosition; label: string }[] = [
    { id: "bottom", label: "Bottom" },
    { id: "left", label: "Left" },
    { id: "right", label: "Right" },
  ];

  let panelEl: HTMLDivElement | undefined = $state();
  let clearingRecents = $state(false);
  let clearRecentsError = $state<string | null>(null);
  let recentsCleared = $state(false);

  function describeError(err: unknown): string {
    if (isAppError(err)) return err.message;
    if (err instanceof Error) return err.message;
    return "an unknown error";
  }

  // Same focus-move technique as UnsavedChangesDialog: without moving real
  // keyboard focus into the panel, a genuine Escape keypress stays on
  // whatever was focused before the dialog opened and never reaches the
  // backdrop's keydown handler below.
  $effect(() => {
    if ($settingsOverlay.open) {
      clearRecentsError = null;
      recentsCleared = false;
      panelEl?.focus();
    }
  });

  async function clearRecentProjects(): Promise<void> {
    clearingRecents = true;
    clearRecentsError = null;
    try {
      await workspaceClearRecents();
      recentsCleared = true;
    } catch (err) {
      clearRecentsError = `Couldn't clear recent projects: ${describeError(err)}`;
    } finally {
      clearingRecents = false;
    }
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
      <h2 class="settings-title">Settings</h2>

      <section class="settings-section">
        <h3 class="settings-section-title">Appearance</h3>
        <div class="settings-row">
          <span class="settings-label">Theme</span>
          <div class="settings-options" role="radiogroup" aria-label="Theme">
            <button
              class="settings-option"
              role="radio"
              aria-checked={$themeSelection === "auto"}
              onclick={() => setTheme("auto")}
            >
              Auto
            </button>
            {#each themes as t (t.id)}
              <button
                class="settings-option"
                role="radio"
                aria-checked={$themeSelection === t.id}
                onclick={() => setTheme(t.id)}
              >
                {t.name}
              </button>
            {/each}
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section-title">Layout</h3>
        <div class="settings-row">
          <span class="settings-label">Terminal dock position</span>
          <div class="settings-options" role="radiogroup" aria-label="Terminal dock position">
            {#each DOCK_POSITIONS as dock (dock.id)}
              <button
                class="settings-option"
                role="radio"
                aria-checked={$terminalPosition === dock.id}
                onclick={() => setTerminalPosition(dock.id)}
              >
                {dock.label}
              </button>
            {/each}
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section-title">Editor</h3>
        <div class="settings-row">
          <span class="settings-label">Zoom</span>
          <div class="settings-zoom">
            <button class="settings-zoom-btn" onclick={zoomOut} aria-label="Zoom out">−</button>
            <span class="settings-zoom-value">{Math.round($zoom * 100)}%</span>
            <button class="settings-zoom-btn" onclick={zoomIn} aria-label="Zoom in">+</button>
            <button class="settings-btn" onclick={resetZoom}>Reset</button>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section-title">Projects</h3>
        <div class="settings-row">
          <span class="settings-label">Recent projects</span>
          <div class="settings-clear-recents">
            <button class="settings-btn" onclick={clearRecentProjects} disabled={clearingRecents}>
              Clear Recent Projects
            </button>
            {#if recentsCleared}
              <span class="settings-status">Cleared</span>
            {/if}
          </div>
        </div>
        {#if clearRecentsError}
          <p class="settings-error">{clearRecentsError}</p>
        {/if}
      </section>

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
    width: 480px;
    max-width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
    padding: 20px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    color: var(--atrium-text-primary);
  }
  .settings-title {
    margin: 0 0 16px;
    font-size: 1.1em;
  }
  .settings-section {
    margin-bottom: 18px;
  }
  .settings-section-title {
    margin: 0 0 8px;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--atrium-text-muted);
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
  .settings-options {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: flex-end;
  }
  .settings-option {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    font-size: 0.9em;
    cursor: pointer;
    padding: 5px 10px;
  }
  .settings-option:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-option[aria-checked="true"] {
    background: var(--atrium-bg-active);
    border-color: var(--atrium-accent);
    color: var(--atrium-accent);
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
  .settings-zoom-value {
    min-width: 3.5em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .settings-clear-recents {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .settings-status {
    color: var(--atrium-text-muted);
    font-size: 0.85em;
  }
  .settings-error {
    margin: 8px 0 0;
    color: var(--atrium-danger);
    font-size: 0.9em;
  }
  .settings-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
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
