<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { isAppError } from "../ipc/commands";

  let {
    initialValue,
    selectExtension,
    onCommit,
    onCancel,
  }: {
    initialValue: string;
    selectExtension: boolean;
    onCommit: (value: string) => Promise<void>;
    onCancel: () => void;
  } = $props();

  let value = $state(untrack(() => initialValue));
  let error = $state<string | null>(null);
  let inputEl: HTMLInputElement | undefined = $state();

  // Guards against a blur that fires after Escape (cancel already resolved the edit) or while a
  // commit is still in flight (a slow rename/create shouldn't be re-submitted by the blur that a
  // subsequent click also triggers).
  let settled = false;
  let pending = false;

  function describeError(err: unknown): string {
    if (isAppError(err)) return err.message;
    if (err instanceof Error) return err.message;
    return "an unknown error";
  }

  onMount(() => {
    if (!inputEl) return;
    inputEl.focus();
    if (selectExtension) {
      const dot = initialValue.lastIndexOf(".");
      const end = dot <= 0 ? initialValue.length : dot;
      inputEl.setSelectionRange(0, end);
    } else {
      inputEl.select();
    }
  });

  async function commit(): Promise<void> {
    if (pending) return;
    pending = true;
    error = null;
    try {
      await onCommit(value.trim());
      settled = true;
    } catch (err) {
      error = describeError(err);
    } finally {
      pending = false;
    }
  }

  function cancel(): void {
    settled = true;
    onCancel();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  function onBlur(): void {
    if (settled || pending) return;
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === initialValue) {
      cancel();
    } else {
      void commit();
    }
  }
</script>

<div class="inline-edit">
  <!-- svelte-ignore a11y_autofocus -->
  <input
    bind:this={inputEl}
    class="inline-edit-input"
    bind:value
    onkeydown={onKeydown}
    onblur={onBlur}
    onclick={(e) => e.stopPropagation()}
  />
  {#if error}
    <div class="inline-edit-error">{error}</div>
  {/if}
</div>

<style>
  .inline-edit {
    flex: 1;
    min-width: 0;
  }
  .inline-edit-input {
    font: inherit;
    color: inherit;
    background: var(--atrium-bg-elevated);
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0 2px;
    width: 100%;
    min-width: 0;
  }
  .inline-edit-input:focus {
    outline: none;
    border-color: var(--atrium-accent);
  }
  .inline-edit-error {
    padding: 2px 0 0;
    color: var(--atrium-danger);
    font-size: 0.85em;
  }
</style>
