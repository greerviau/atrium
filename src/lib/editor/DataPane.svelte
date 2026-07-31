<script lang="ts">
  import { onMount } from "svelte";
  import { dataQuery, type DataQueryResult } from "../ipc/commands";
  import { onFsChanged } from "../ipc/events";
  import { describeError } from "../stores/errorToast";

  let { filePath, workspaceId }: { filePath: string; workspaceId: string } = $props();

  const DEFAULT_QUERY = "SELECT * FROM data LIMIT 100";
  let query = $state(DEFAULT_QUERY);
  let result = $state<DataQueryResult | null>(null);
  let error = $state<string | null>(null);
  let running = $state(false);
  let queryGeneration = 0;

  async function runQuery(): Promise<void> {
    const generation = ++queryGeneration;
    running = true;
    error = null;
    try {
      const next = await dataQuery(workspaceId, filePath, query.trim() || DEFAULT_QUERY);
      if (generation === queryGeneration) result = next;
    } catch (err) {
      if (generation === queryGeneration) {
        result = null;
        error = describeError(err);
      }
    } finally {
      if (generation === queryGeneration) running = false;
    }
  }

  function onQueryKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runQuery();
    }
  }

  onMount(() => {
    void runQuery();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onFsChanged((event) => {
      if (event.workspaceId === workspaceId && event.path === filePath && event.kind !== "remove") {
        void runQuery();
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  });
</script>

<div class="data-pane">
  <form class="query-bar" onsubmit={(event) => { event.preventDefault(); void runQuery(); }}>
    <textarea
      aria-label="SQL query"
      bind:value={query}
      onkeydown={onQueryKeydown}
      rows="2"
      spellcheck="false"
    ></textarea>
    <button type="submit" disabled={running}>{running ? "Running…" : "Run"}</button>
  </form>
  <div class="query-hint">Query <code>data</code> with SELECT, WHERE, ORDER BY, and LIMIT. Press {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to run.</div>

  {#if error}
    <div class="data-error" role="alert">{error}</div>
  {:else if running && !result}
    <div class="data-empty">Loading data…</div>
  {:else if result}
    <div class="data-summary">
      {result.rows.length}{result.truncated ? "+" : ""} rows · {result.columns.length} columns
      {#if result.truncated}<span>Result capped at 1,000 rows.</span>{/if}
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            {#each result.columns as column}
              <th scope="col">{column}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each result.rows as row}
            <tr>
              {#each result.columns as _, index}
                <td class:null-value={row[index] === null}>{row[index] ?? "NULL"}</td>
              {/each}
            </tr>
          {:else}
            <tr><td class="no-rows" colspan={Math.max(result.columns.length, 1)}>No rows</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .data-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--atrium-bg-base);
    font-size: 13px;
  }

  .query-bar {
    display: flex;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--atrium-border);
    background: var(--atrium-bg-surface);
  }

  textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    padding: 6px 8px;
    border: 1px solid var(--atrium-border);
    border-radius: 4px;
    background: var(--atrium-bg-base);
    color: var(--atrium-text-primary);
    font: 12px/1.4 var(--atrium-mono-font);
  }

  button {
    align-self: flex-start;
    padding: 6px 12px;
    border: 1px solid var(--atrium-border);
    border-radius: 4px;
    background: var(--atrium-bg-active);
    color: var(--atrium-text-primary);
    cursor: pointer;
  }

  button:hover:not(:disabled) { background: var(--atrium-bg-hover); }
  button:disabled { opacity: 0.6; cursor: default; }

  .query-hint,
  .data-summary,
  .data-empty,
  .data-error {
    padding: 5px 10px;
    color: var(--atrium-text-muted);
    flex-shrink: 0;
  }

  .query-hint { font-size: 11px; border-bottom: 1px solid var(--atrium-border-subtle); }
  code { font-family: var(--atrium-mono-font); color: var(--atrium-text-secondary); }
  .data-summary { font-size: 11px; }
  .data-summary span { margin-left: 10px; color: var(--atrium-warning); }
  .data-error { color: var(--atrium-danger-text); background: var(--atrium-danger); }
  .table-scroll { overflow: auto; min-height: 0; flex: 1; }
  table { border-collapse: collapse; min-width: 100%; white-space: nowrap; font-family: var(--atrium-mono-font); font-size: 12px; }
  th, td { padding: 5px 10px; border-right: 1px solid var(--atrium-border-subtle); border-bottom: 1px solid var(--atrium-border-subtle); text-align: left; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; z-index: 1; background: var(--atrium-bg-elevated); color: var(--atrium-text-primary); font-weight: 600; }
  td { color: var(--atrium-text-secondary); }
  td.null-value { color: var(--atrium-text-muted); font-style: italic; }
  .no-rows { text-align: center; color: var(--atrium-text-muted); }
</style>
