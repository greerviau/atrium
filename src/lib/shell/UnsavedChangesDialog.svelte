<script lang="ts">
  import { closePrompt } from "../stores/closePrompt";
  import { closeTab, requestSave } from "../stores/tabs";
  import { appConfirmClose } from "../ipc/commands";

  function basename(path: string): string {
    return path.split("/").pop() ?? path;
  }

  async function saveTabThenClose(path: string): Promise<void> {
    await requestSave(path);
    closeTab(path);
    closePrompt.set(null);
  }

  function discardTab(path: string): void {
    closeTab(path);
    closePrompt.set(null);
  }

  async function saveAllThenClose(paths: string[]): Promise<void> {
    for (const path of paths) {
      await requestSave(path);
    }
    await appConfirmClose();
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
        <div class="close-prompt-actions">
          <button class="close-prompt-btn" onclick={cancel}>Cancel</button>
          <button class="close-prompt-btn danger" onclick={() => discardTab(prompt.path)}>
            Don't Save
          </button>
          <button class="close-prompt-btn primary" onclick={() => void saveTabThenClose(prompt.path)}>
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
        <div class="close-prompt-actions">
          <button class="close-prompt-btn" onclick={cancel}>Cancel</button>
          <button class="close-prompt-btn danger" onclick={() => void discardAllThenClose()}>
            Don't Save
          </button>
          <button
            class="close-prompt-btn primary"
            onclick={() => void saveAllThenClose(prompt.paths)}
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
  .close-prompt-btn.primary {
    background: var(--atrium-accent);
    border-color: var(--atrium-accent);
    color: var(--atrium-text-inverse);
  }
  .close-prompt-btn.danger {
    color: var(--atrium-danger);
  }
</style>
