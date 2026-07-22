<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { isAppError } from "../ipc/commands";

  let {
    initialValue,
    selectBaseNameOnly,
    onCommit,
    onCancel,
  }: {
    initialValue: string;
    selectBaseNameOnly: boolean;
    onCommit: (value: string) => Promise<void>;
    onCancel: () => void;
  } = $props();

  // Reads the prop once at creation time; this component is always freshly mounted for a given
  // edit session (keyed on `#if $editingPath === ...` / `$pendingCreate`), so `initialValue`
  // never changes during its lifetime. `untrack` doesn't change that (there's no reactive
  // context here to track against) — it only silences the compiler's `state_referenced_locally`
  // warning, which otherwise fires on any prop read used to seed local state.
  let value = $state(untrack(() => initialValue));
  let error = $state<string | null>(null);
  let inputEl: HTMLInputElement | undefined = $state();

  // Guards against a blur that fires after Escape (cancel already resolved the edit) or while a
  // commit is still in flight (a slow rename/create shouldn't be re-submitted by the blur that a
  // subsequent click also triggers).
  let settled = false;
  let pending = false;

  function describeError(err: unknown, submittedName: string): string {
    if (isAppError(err) && err.code === "ALREADY_EXISTS") {
      return `A file or folder named "${submittedName}" already exists`;
    }
    if (isAppError(err)) return err.message;
    if (err instanceof Error) return err.message;
    return "an unknown error";
  }

  onMount(() => {
    if (!inputEl) return;
    inputEl.focus();
    if (selectBaseNameOnly) {
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
    const submitted = value.trim();
    try {
      await onCommit(submitted);
      settled = true;
    } catch (err) {
      error = describeError(err, submitted);
      // A commit rejection reached via blur leaves the input unfocused; re-focus it so the
      // error is actionable (Escape/retyping) without the user having to click back in — the
      // row's own click handling is suppressed while it's mid-edit (`FileTreeNode.svelte`).
      inputEl?.focus();
      inputEl?.select();
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
