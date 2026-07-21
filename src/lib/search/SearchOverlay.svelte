<script lang="ts">
  import { searchOverlay, closeSearch } from "./searchOverlay";
  import {
    searchWorkspace,
    isAppError,
    localWorkspaceId,
    type SearchMatch,
  } from "../ipc/commands";
  import { openFile } from "../stores/tabs";
  import { workspace } from "../stores/workspace";

  const DEBOUNCE_MS = 150;
  // Below this, a query is too low-selectivity to be worth a workspace-wide
  // search (a 1-2 character query matches almost everything in most
  // projects) and firing one just produces slow, throwaway results.
  const MIN_QUERY_LENGTH = 3;

  let query = $state("");
  let caseSensitive = $state(false);
  let regexMode = $state(false);
  let results = $state<SearchMatch[]>([]);
  let truncated = $state(false);
  let errorMessage = $state<string | null>(null);
  let hasSearched = $state(false);
  let selectedIndex = $state(0);
  let isSearching = $state(false);

  let inputEl: HTMLInputElement | undefined = $state();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;
  let wasOpen = false;

  function resetState(): void {
    query = "";
    caseSensitive = false;
    regexMode = false;
    results = [];
    truncated = false;
    errorMessage = null;
    hasSearched = false;
    selectedIndex = 0;
    isSearching = false;
    requestId += 1;
  }

  // Opening from closed resets every field (section 4.4: toggles, and by
  // extension the rest of the transient UI state, default fresh each time);
  // the freshly (re)created `<input autofocus>` below picks up focus on its
  // own. Pressing the shortcut again while already open does not reset —
  // it only refocuses and selects the existing query text, matching VS
  // Code's own Ctrl/Cmd+Shift+F behavior, so a second press doesn't wipe
  // out what the user already typed.
  $effect(() => {
    const isOpen = $searchOverlay.open;
    if (isOpen) {
      if (!wasOpen) {
        resetState();
      } else {
        inputEl?.focus();
        inputEl?.select();
      }
    } else if (wasOpen && debounceTimer) {
      clearTimeout(debounceTimer);
    }
    wasOpen = isOpen;
  });

  async function runSearch(myRequestId: number): Promise<void> {
    const q = query;
    if (q === "" || q.length < MIN_QUERY_LENGTH) {
      results = [];
      truncated = false;
      errorMessage = null;
      hasSearched = false;
      selectedIndex = 0;
      return;
    }
    try {
      const response = await searchWorkspace(localWorkspaceId(), q, {
        caseSensitive,
        regex: regexMode,
      });
      if (myRequestId !== requestId) return; // superseded by a newer query
      results = response.matches;
      truncated = response.truncated;
      errorMessage = null;
      hasSearched = true;
      selectedIndex = 0;
      isSearching = false;
    } catch (err) {
      if (myRequestId !== requestId) return;
      if (isAppError(err) && err.code === "INVALID_REGEX") {
        errorMessage = err.message;
      } else {
        console.error("atrium: search failed", err);
        errorMessage = null;
      }
      results = [];
      truncated = false;
      hasSearched = true;
      isSearching = false;
    }
  }

  // Every keystroke (or toggle change) bumps `requestId` immediately, not
  // just when a new backend call actually fires. That's what makes a
  // still-running search's response get ignored the instant it's
  // superseded — including when the query is cleared or shortened below
  // `MIN_QUERY_LENGTH` before that response ever arrives, which previously
  // let a stale response repopulate the results list after the user had
  // already moved on. The backend call itself stays debounced by
  // `DEBOUNCE_MS`; only the invalidation is immediate. `LocalWorkspace::search`
  // (src-tauri) mirrors this with its own generation counter, so a
  // superseded search is also abandoned mid-walk on the backend instead of
  // running to completion for a result nobody will use.
  //
  // `isSearching` turns on right here — covering the debounce wait itself,
  // not just the backend round trip — so the loading indicator is visible
  // from the moment a qualifying keystroke lands, since that wait is exactly
  // what otherwise looks like nothing is happening. It turns off in
  // `runSearch` once the (non-superseded) result settles, or immediately
  // here if the query no longer qualifies for a search at all.
  $effect(() => {
    void query;
    void caseSensitive;
    void regexMode;
    requestId += 1;
    const myRequestId = requestId;
    isSearching = query.length >= MIN_QUERY_LENGTH;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(myRequestId), DEBOUNCE_MS);
  });

  let belowMinLength = $derived(query.length > 0 && query.length < MIN_QUERY_LENGTH);

  interface ResultGroup {
    path: string;
    matches: (SearchMatch & { index: number })[];
  }

  let groups = $derived.by((): ResultGroup[] => {
    const out: ResultGroup[] = [];
    results.forEach((match, index) => {
      const last = out[out.length - 1];
      if (last && last.path === match.path) {
        last.matches.push({ ...match, index });
      } else {
        out.push({ path: match.path, matches: [{ ...match, index }] });
      }
    });
    return out;
  });

  function relativePath(path: string): string {
    const root = $workspace.root;
    if (!root) return path;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  async function selectResult(index: number): Promise<void> {
    const match = results[index];
    if (!match) return;
    await openFile(match.path, { line: match.line, col: match.column });
    closeSearch();
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length > 0) {
        selectedIndex = (selectedIndex + 1) % results.length;
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length > 0) {
        selectedIndex = (selectedIndex - 1 + results.length) % results.length;
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      void selectResult(selectedIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  }
</script>

{#if $searchOverlay.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="search-backdrop" onclick={closeSearch}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="search-panel"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Find in Files"
      tabindex="-1"
    >
      <div class="search-input-row">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={inputEl}
          bind:value={query}
          onkeydown={onInputKeydown}
          placeholder="Search across the project…"
          autofocus
        />
        {#if isSearching}
          <span class="search-spinner" aria-hidden="true"></span>
        {/if}
        <button
          class="search-toggle"
          class:active={caseSensitive}
          onclick={() => (caseSensitive = !caseSensitive)}
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
        >
          Aa
        </button>
        <button
          class="search-toggle"
          class:active={regexMode}
          onclick={() => (regexMode = !regexMode)}
          aria-label="Use regular expression"
          aria-pressed={regexMode}
          title="Use regular expression"
        >
          .*
        </button>
      </div>

      {#if errorMessage}
        <div class="search-error">{errorMessage}</div>
      {:else if belowMinLength}
        <div class="search-empty">Type at least {MIN_QUERY_LENGTH} characters to search</div>
      {:else if hasSearched}
        {#if results.length === 0}
          <div class="search-empty">No results</div>
        {:else}
          <div class="search-status">
            {results.length} result{results.length === 1 ? "" : "s"} in {groups.length}
            file{groups.length === 1 ? "" : "s"}{truncated
              ? " — results truncated, refine your search"
              : ""}
          </div>
          <div class="search-results" role="listbox">
            {#each groups as group (group.path)}
              <div class="search-group">
                <div class="search-group-header">{relativePath(group.path)}</div>
                {#each group.matches as match (match.index)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    class="search-result-row"
                    class:selected={match.index === selectedIndex}
                    onclick={() => void selectResult(match.index)}
                    role="option"
                    tabindex="-1"
                    aria-selected={match.index === selectedIndex}
                  >
                    <span class="search-result-line">{match.line}</span>
                    <span class="search-result-text"
                      >{match.lineText.slice(
                        0,
                        match.matchStart,
                      )}<mark>{match.lineText.slice(
                        match.matchStart,
                        match.matchEnd,
                      )}</mark>{match.lineText.slice(match.matchEnd)}</span
                    >
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .search-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    z-index: 3000;
  }
  .search-panel {
    background: var(--atrium-bg-elevated);
    border: 1px solid var(--atrium-border);
    border-radius: 8px;
    width: 640px;
    max-width: 90vw;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .search-input-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px;
    border-bottom: 1px solid var(--atrium-border);
    flex-shrink: 0;
  }
  .search-input-row input {
    flex: 1;
    padding: 8px 10px;
    font: inherit;
    background: var(--atrium-bg-surface);
    color: inherit;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
  }
  .search-spinner {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border: 2px solid var(--atrium-border);
    border-top-color: var(--atrium-accent);
    border-radius: 50%;
    animation: search-spin 0.6s linear infinite;
  }
  @keyframes search-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .search-toggle {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    font-size: 0.85em;
    cursor: pointer;
    padding: 7px 10px;
    opacity: 0.7;
  }
  .search-toggle:hover {
    opacity: 1;
  }
  .search-toggle.active {
    opacity: 1;
    background: var(--atrium-bg-active);
    border-color: var(--atrium-accent);
    color: var(--atrium-accent);
  }
  .search-error {
    padding: 12px 14px;
    color: var(--atrium-danger);
  }
  .search-empty {
    padding: 12px 14px;
    color: var(--atrium-text-muted);
  }
  .search-status {
    padding: 8px 14px;
    font-size: 0.85em;
    color: var(--atrium-text-muted);
    flex-shrink: 0;
  }
  .search-results {
    overflow-y: auto;
    min-height: 0;
  }
  .search-group-header {
    padding: 6px 14px;
    font-size: 0.8em;
    color: var(--atrium-text-muted);
    background: var(--atrium-bg-surface);
    position: sticky;
    top: 0;
  }
  .search-result-row {
    display: flex;
    gap: 10px;
    padding: 4px 14px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .search-result-row:hover,
  .search-result-row.selected {
    background: var(--atrium-bg-hover);
  }
  .search-result-line {
    flex-shrink: 0;
    color: var(--atrium-text-muted);
    min-width: 2.5em;
    text-align: right;
  }
  .search-result-text {
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--atrium-mono-font);
    font-size: 0.9em;
  }
  .search-result-text mark {
    background: var(--atrium-search-match-bg);
    color: inherit;
  }
</style>
