<script lang="ts">
  import { searchOverlay, closeSearch, type SearchMode } from "./searchOverlay";
  import {
    searchWorkspace,
    findFiles,
    isAppError,
    localWorkspaceId,
    type SearchMatch,
    type FileMatch,
  } from "../ipc/commands";
  import { openFile } from "../stores/tabs";
  import { workspace } from "../stores/workspace";
  import { tooltip } from "../ui/tooltip";

  const DEBOUNCE_MS = 150;
  // Below this, a content-search query is too low-selectivity to be worth a
  // workspace-wide search (a 1-2 character query matches almost everything
  // in most projects) and firing one just produces slow, throwaway results.
  // Files mode has no equivalent gate — an empty/short query there is a
  // legitimate "browse all files" state, not a too-low-selectivity query.
  const MIN_QUERY_LENGTH = 3;

  let mode = $state<SearchMode>("content");
  let query = $state("");
  let caseSensitive = $state(false);
  let regexMode = $state(false);
  let results = $state<SearchMatch[]>([]);
  let fileResults = $state<FileMatch[]>([]);
  let truncated = $state(false);
  let errorMessage = $state<string | null>(null);
  let hasSearched = $state(false);
  let selectedIndex = $state(0);
  let isSearching = $state(false);

  let inputEl: HTMLInputElement | undefined = $state();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;
  let previousOpen = false;
  let previousMode: SearchMode | undefined;

  function resetState(): void {
    query = "";
    caseSensitive = false;
    regexMode = false;
    results = [];
    fileResults = [];
    truncated = false;
    errorMessage = null;
    hasSearched = false;
    selectedIndex = 0;
    isSearching = false;
    requestId += 1;
  }

  // Content and Files are two fully separate, exclusive views — Cmd/Ctrl+Shift+F
  // always opens grep, Cmd/Ctrl+P always opens the file picker, and there is
  // no in-panel control to switch between them. So the only two things that
  // can happen while `open`: a genuinely fresh open, or the *other* mode's
  // exclusive shortcut/menu item firing while this one is already open —
  // both are treated identically, as a full reset into the requested mode,
  // never an in-place "keep what I typed" switch (there is nothing to
  // preserve across two views that are never meant to be interchangeable).
  // Re-pressing the *same* mode's shortcut while it's already open just
  // refocuses/selects, matching VS Code's own Ctrl/Cmd+Shift+F behavior.
  $effect(() => {
    const isOpen = $searchOverlay.open;
    const storeMode = $searchOverlay.mode;

    if (isOpen && (!previousOpen || storeMode !== previousMode)) {
      resetState();
      mode = storeMode;
    } else if (isOpen && previousOpen && storeMode === previousMode) {
      inputEl?.focus();
      inputEl?.select();
    } else if (!isOpen && previousOpen && debounceTimer) {
      clearTimeout(debounceTimer);
    }

    previousOpen = isOpen;
    previousMode = storeMode;
  });

  async function runSearch(myRequestId: number): Promise<void> {
    const q = query;
    if (mode === "content") {
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
    } else {
      try {
        const response = await findFiles(localWorkspaceId(), q);
        if (myRequestId !== requestId) return; // superseded by a newer query
        fileResults = response.matches;
        truncated = response.truncated;
        errorMessage = null;
        hasSearched = true;
        selectedIndex = 0;
        isSearching = false;
      } catch (err) {
        if (myRequestId !== requestId) return;
        console.error("atrium: find files failed", err);
        fileResults = [];
        truncated = false;
        errorMessage = null;
        hasSearched = true;
        isSearching = false;
      }
    }
  }

  // Every keystroke (or toggle/mode change) bumps `requestId` immediately,
  // not just when a new backend call actually fires. That's what makes a
  // still-running search's response get ignored the instant it's
  // superseded — including when the query is cleared or shortened below
  // `MIN_QUERY_LENGTH` before that response ever arrives, which previously
  // let a stale response repopulate the results list after the user had
  // already moved on. The backend call itself stays debounced by
  // `DEBOUNCE_MS`; only the invalidation is immediate. `LocalWorkspace::search`
  // / `LocalWorkspace::find_files` (src-tauri) mirror this with their own
  // (independent) generation counters, so a superseded search is also
  // abandoned mid-walk on the backend instead of running to completion for
  // a result nobody will use.
  //
  // `isSearching` turns on right here — covering the debounce wait itself,
  // not just the backend round trip — so the loading indicator is visible
  // from the moment a qualifying keystroke lands, since that wait is exactly
  // what otherwise looks like nothing is happening. It turns off in
  // `runSearch` once the (non-superseded) result settles, or immediately
  // here if a content-mode query no longer qualifies for a search at all.
  // Files mode has no such disqualifying length, so it's always "searching"
  // once the debounce fires.
  $effect(() => {
    void query;
    void caseSensitive;
    void regexMode;
    void mode;
    requestId += 1;
    const myRequestId = requestId;
    isSearching = mode === "content" ? query.length >= MIN_QUERY_LENGTH : true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(myRequestId), DEBOUNCE_MS);
  });

  let belowMinLength = $derived(
    mode === "content" && query.length > 0 && query.length < MIN_QUERY_LENGTH,
  );
  let resultCount = $derived(mode === "content" ? results.length : fileResults.length);

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

  interface HighlightSegment {
    text: string;
    matched: boolean;
  }

  // `Array.from(displayPath)`, not `displayPath[i]`/`.slice()`: splits by
  // Unicode code point so array indices line up with the char (Unicode
  // scalar) indices the backend's `match_indices` are computed in, which
  // would otherwise be off for any path containing a non-BMP character (a
  // raw UTF-16 index into `displayPath` can split a surrogate pair). Walks
  // the code-point array once, coalescing adjacent matched indices into one
  // `{ text, matched: true }` segment so a contiguous run renders as a
  // single <mark>, not one per character.
  function highlightSegments(displayPath: string, indices: number[]): HighlightSegment[] {
    const chars = Array.from(displayPath);
    const matched = new Set(indices);
    const segments: HighlightSegment[] = [];
    let current = "";
    let currentMatched = false;
    for (let i = 0; i < chars.length; i++) {
      const isMatched = matched.has(i);
      if (current !== "" && isMatched !== currentMatched) {
        segments.push({ text: current, matched: currentMatched });
        current = "";
      }
      current += chars[i];
      currentMatched = isMatched;
    }
    if (current !== "") {
      segments.push({ text: current, matched: currentMatched });
    }
    return segments;
  }

  async function selectResult(index: number): Promise<void> {
    if (mode === "content") {
      const match = results[index];
      if (!match) return;
      await openFile(match.path, { line: match.line, col: match.column });
    } else {
      const match = fileResults[index];
      if (!match) return;
      await openFile(match.path);
    }
    closeSearch();
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (resultCount > 0) {
        selectedIndex = (selectedIndex + 1) % resultCount;
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (resultCount > 0) {
        selectedIndex = (selectedIndex - 1 + resultCount) % resultCount;
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
      aria-label={mode === "content" ? "Find in Files" : "Go to File"}
      tabindex="-1"
    >
      <div class="search-input-row">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={inputEl}
          bind:value={query}
          onkeydown={onInputKeydown}
          placeholder={mode === "content" ? "Search across the project…" : "Go to file…"}
          autofocus
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
        />
        {#if isSearching}
          <span class="search-spinner" aria-hidden="true"></span>
        {/if}
        {#if mode === "content"}
          <button
            class="search-toggle"
            class:active={caseSensitive}
            onclick={() => (caseSensitive = !caseSensitive)}
            aria-label="Match case"
            aria-pressed={caseSensitive}
            use:tooltip={{ label: "Match case" }}
          >
            Aa
          </button>
          <button
            class="search-toggle"
            class:active={regexMode}
            onclick={() => (regexMode = !regexMode)}
            aria-label="Use regular expression"
            aria-pressed={regexMode}
            use:tooltip={{ label: "Use regular expression" }}
          >
            .*
          </button>
        {/if}
      </div>

      {#if errorMessage}
        <div class="search-error">{errorMessage}</div>
      {:else if belowMinLength}
        <div class="search-empty">Type at least {MIN_QUERY_LENGTH} characters to search</div>
      {:else if hasSearched}
        {#if mode === "content"}
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
        {:else if fileResults.length === 0}
          <div class="search-empty">No matching files</div>
        {:else}
          <div class="search-status">
            {fileResults.length} file{fileResults.length === 1 ? "" : "s"}{truncated
              ? " — results truncated, refine your search"
              : ""}
          </div>
          <div class="search-results" role="listbox">
            {#each fileResults as match, index (match.path)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="search-result-row"
                class:selected={index === selectedIndex}
                onclick={() => void selectResult(index)}
                role="option"
                tabindex="-1"
                aria-selected={index === selectedIndex}
              >
                <span class="search-result-text">
                  {#each highlightSegments(match.displayPath, match.matchIndices) as segment}
                    {#if segment.matched}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                  {/each}
                </span>
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
  .search-input-row input:focus {
    outline: none;
    border-color: var(--atrium-accent);
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
