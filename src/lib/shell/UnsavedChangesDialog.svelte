<script lang="ts">
  import { closePrompt } from "../stores/closePrompt";
  import { closeTab, requestSave } from "../stores/tabs";
  import { appConfirmClose, isAppError } from "../ipc/commands";

  let panelEl: HTMLDivElement | undefined = $state();
  let errorMessage = $state<string | null>(null);
  let saving = $state(false);

  function basename(path: string): string {
    return path.split("/").pop() ?? path;
  }

  function describeError(err: unknown): string {
    if (isAppError(err)) return err.message;
    if (err instanceof Error) return err.message;
    return "an unknown error";
  }

  // Moves real keyboard focus into the dialog so a genuine Escape keypress
  // bubbles to the backdrop's handler below — without this, focus stays on
  // whatever was focused before the dialog opened (e.g. the tab's "×"
  // button), which never sees the keydown at all.
  $effect(() => {
    if ($closePrompt) {
      errorMessage = null;
      panelEl?.focus();
    }
  });

  async function saveTabThenClose(path: string): Promise<void> {
    saving = true;
    try {
      await requestSave(path);
    } catch (err) {
      errorMessage = `Couldn't save ${basename(path)}: ${describeError(err)}`;
      return;
    } finally {
      saving = false;
    }
    closeTab(path);
    closePrompt.set(null);
  }

  function discardTab(path: string): void {
    closeTab(path);
    closePrompt.set(null);
  }

  async function saveAllThenClose(paths: string[]): Promise<void> {
    saving = true;
    try {
      for (const path of paths) {
        try {
          await requestSave(path);
        } catch (err) {
          errorMessage = `Couldn't save ${basename(path)}: ${describeError(err)}`;
          return;
        }
      }
      await appConfirmClose();
    } finally {
      saving = false;
    }
    closePrompt.set(null);
  }

  async function discardAllThenClose(): Promise<void> {
    await appConfirmClose();
    closePrompt.set(null);
  }

  function cancel(): void {
    closePrompt.set(null);
  }

  function onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      cancel();
    }
  }
</script>

{#if $closePrompt}
  {@const prompt = $closePrompt}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="close-prompt-backdrop" onclick={cancel} onkeydown={onBackdropKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      bind:this={panelEl}
      class="close-prompt-panel"
      onclick={(e) => e.stopPropagation()}
      role="alertdialog"
      aria-modal="true"
      aria-label="Unsaved changes"
      tabindex="-1"
    >
      {#if prompt.kind === "tab"}
        <p class="close-prompt-message">
          Do you want to save the changes you made to <strong>{basename(prompt.path)}</strong>?
          Your changes will be lost if you don't save them.
        </p>
        {#if errorMessage}
          <p class="close-prompt-error">{errorMessage}</p>
        {/if}
        <div class="close-prompt-actions">
          <button class="close-prompt-btn" onclick={cancel} disabled={saving}>Cancel</button>
          <button
            class="close-prompt-btn danger"
            onclick={() => discardTab(prompt.path)}
            disabled={saving}
          >
            Don't Save
          </button>
          <button
            class="close-prompt-btn primary"
            onclick={() => void saveTabThenClose(prompt.path)}
            disabled={saving}
          >
            Save
          </button>
        </div>
      {:else}
        <p class="close-prompt-message">
          You have unsaved changes in {prompt.paths.length} file{prompt.paths.length === 1
            ? ""
            : "s"}: {prompt.paths.map(basename).join(", ")}. Do you want to save your changes
          before closing?
        </p>
        {#if errorMessage}
          <p class="close-prompt-error">{errorMessage}</p>
        {/if}
        <div class="close-prompt-actions">
          <button class="close-prompt-btn" onclick={cancel} disabled={saving}>Cancel</button>
          <button
            class="close-prompt-btn danger"
            onclick={() => void discardAllThenClose()}
            disabled={saving}
          >
            Don't Save
          </button>
          <button
            class="close-prompt-btn primary"
            onclick={() => void saveAllThenClose(prompt.paths)}
            disabled={saving}
          >
            Save All
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .close-prompt-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 4000;
  }
  .close-prompt-panel {
    background: var(--atrium-bg-elevated);
    border: 1px solid var(--atrium-border);
    border-radius: 8px;
    width: 440px;
    max-width: 90vw;
    padding: 20px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .close-prompt-message {
    margin: 0 0 18px;
    color: var(--atrium-text-primary);
    line-height: 1.5;
  }
  .close-prompt-error {
    margin: -8px 0 18px;
    color: var(--atrium-danger);
    line-height: 1.5;
  }
  .close-prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .close-prompt-btn {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 7px 14px;
  }
  .close-prompt-btn:hover {
    background: var(--atrium-bg-hover);
  }
  .close-prompt-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .close-prompt-btn.primary {
    background: var(--atrium-accent);
    border-color: var(--atrium-accent);
    color: var(--atrium-text-inverse);
  }
  .close-prompt-btn.danger {
    color: var(--atrium-danger);
  }
</style>
