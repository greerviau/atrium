<script lang="ts">
  import { onMount } from "svelte";
  import { dataQuery, type DataQueryResult } from "../ipc/commands";
  import { onFsChanged } from "../ipc/events";
  import { describeError } from "../stores/errorToast";

  let { filePath, workspaceId }: { filePath: string; workspaceId: string } = $props();

  type NumericPageSize = 10 | 25 | 50 | 100 | 500;
  type PageSize = NumericPageSize | "all";

  const DEFAULT_QUERY = "SELECT * FROM data";
  const DEFAULT_PAGE_SIZE: NumericPageSize = 25;
  let query = $state(DEFAULT_QUERY);
  let result = $state<DataQueryResult | null>(null);
  let error = $state<string | null>(null);
  let running = $state(false);
  let page = $state(0);
  let pageSize = $state<PageSize>(DEFAULT_PAGE_SIZE);
  let queryGeneration = 0;
  const numericPageSize = $derived(pageSize === "all" ? null : pageSize);
  const totalPages = $derived(
    result && numericPageSize
      ? Math.max(1, Math.ceil(result.totalRows / numericPageSize))
      : 1,
  );
  const firstRow = $derived(
    result && result.totalRows > 0 && numericPageSize
      ? page * numericPageSize + 1
      : result?.totalRows
        ? 1
        : 0,
  );
  const lastRow = $derived(
    result && result.totalRows > 0
      ? numericPageSize
        ? Math.min((page + 1) * numericPageSize, result.totalRows)
        : result.totalRows
      : 0,
  );

  async function runQuery(resetPage = false): Promise<void> {
    if (resetPage) page = 0;
    const requestedPage = page;
    const generation = ++queryGeneration;
    running = true;
    error = null;
    try {
      const next = await dataQuery(
        workspaceId,
        filePath,
        query.trim() || DEFAULT_QUERY,
        requestedPage,
        numericPageSize,
      );
      if (generation === queryGeneration) {
        if (numericPageSize && next.totalRows > 0) {
          const lastPage = Math.max(0, Math.ceil(next.totalRows / numericPageSize) - 1);
          if (requestedPage > lastPage) {
            page = lastPage;
            void runQuery();
            return;
          }
        }
        result = next;
      }
    } catch (err) {
      if (generation === queryGeneration) {
        result = null;
        error = describeError(err);
      }
    } finally {
      if (generation === queryGeneration) running = false;
    }
  }

  function goToPage(nextPage: number): void {
    if (nextPage < 0 || nextPage >= totalPages || nextPage === page) return;
    page = nextPage;
    void runQuery();
  }

  function onPageSizeChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    pageSize = value === "all" ? "all" : Number(value) as NumericPageSize;
    page = 0;
    void runQuery();
  }

  function onQueryKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runQuery(true);
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
  <form class="query-bar" onsubmit={(event) => { event.preventDefault(); void runQuery(true); }}>
    <textarea
      aria-label="SQL query"
      bind:value={query}
      onkeydown={onQueryKeydown}
      rows="1"
      spellcheck="false"
    ></textarea>
    <button type="submit" disabled={running}>{running ? "Running…" : "Run"}</button>
  </form>
  <div class="query-hint">Query <code>data</code> with SELECT, DISTINCT, WHERE, ORDER BY, and LIMIT. Press {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to run.</div>

  {#if error}
    <div class="data-error" role="alert">{error}</div>
  {:else if running && !result}
    <div class="data-empty">Loading data…</div>
  {:else if result}
    <div class="data-toolbar">
      <div class="data-summary">
        {#if result.totalRows === 0}0 rows{:else}{firstRow}-{lastRow} of {result.totalRows} rows{/if} · {result.columns.length} columns
        {#if result.truncated}<span>Source capped at 100,000 rows.</span>{/if}
      </div>
      <div class="pagination" aria-label="Table pagination">
        <label>
          Rows per page
          <select aria-label="Rows per page" value={pageSize} onchange={onPageSizeChange} disabled={running}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={500}>500</option>
            <option value="all">All</option>
          </select>
        </label>
        <button type="button" onclick={() => goToPage(0)} disabled={running || page === 0} aria-label="First page">First</button>
        <button type="button" onclick={() => goToPage(page - 1)} disabled={running || page === 0} aria-label="Previous page">‹</button>
        <span>Page {page + 1} of {totalPages}</span>
        <button type="button" onclick={() => goToPage(page + 1)} disabled={running || page + 1 >= totalPages} aria-label="Next page">›</button>
        <button type="button" onclick={() => goToPage(totalPages - 1)} disabled={running || page + 1 >= totalPages} aria-label="Last page">Last</button>
      </div>
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
    min-height: calc(1.4em + 14px);
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
  .data-empty,
  .data-error {
    padding: 5px 10px;
    color: var(--atrium-text-muted);
    flex-shrink: 0;
  }

  .query-hint { font-size: 11px; border-bottom: 1px solid var(--atrium-border-subtle); }
  code { font-family: var(--atrium-mono-font); color: var(--atrium-text-secondary); }
  .data-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 10px;
    color: var(--atrium-text-muted);
    flex-shrink: 0;
  }
  .data-summary { font-size: 11px; }
  .data-summary span { margin-left: 10px; color: var(--atrium-warning); }
  .pagination { display: flex; align-items: center; gap: 5px; font-size: 11px; }
  .pagination label { display: flex; align-items: center; gap: 5px; }
  .pagination select { padding: 3px 5px; border: 1px solid var(--atrium-border); border-radius: 3px; background: var(--atrium-bg-base); color: var(--atrium-text-primary); }
  .pagination button { padding: 3px 7px; }
  .data-error { color: var(--atrium-danger-text); background: var(--atrium-danger); }
  @media (max-width: 700px) {
    .data-toolbar { align-items: flex-start; flex-direction: column; gap: 4px; }
  }
  .table-scroll { overflow: auto; min-height: 0; flex: 1; }
  table { border-collapse: collapse; min-width: 100%; white-space: nowrap; font-family: var(--atrium-mono-font); font-size: 12px; }
  th, td { padding: 5px 10px; border-right: 1px solid var(--atrium-border-subtle); border-bottom: 1px solid var(--atrium-border-subtle); text-align: left; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; z-index: 1; background: var(--atrium-bg-elevated); color: var(--atrium-text-primary); font-weight: 600; }
  td { color: var(--atrium-text-secondary); }
  td.null-value { color: var(--atrium-text-muted); font-style: italic; }
  .no-rows { text-align: center; color: var(--atrium-text-muted); }
</style>
