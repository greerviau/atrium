import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import SearchOverlay from "../../src/lib/search/SearchOverlay.svelte";
import { searchOverlay } from "../../src/lib/search/searchOverlay";
import { workspace } from "../../src/lib/stores/workspace";
import { recordFileOpened, getRecentFiles } from "../../src/lib/stores/recentFiles";
import { errorToast, dismissErrorToast } from "../../src/lib/stores/errorToast";
import * as commands from "../../src/lib/ipc/commands";
import * as tabsStore from "../../src/lib/stores/tabs";
import type { SearchResults, FileSearchResults } from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  searchWorkspace: vi.fn(),
  findFiles: vi.fn(),
  isAppError: (value: unknown): value is { code: string; message: string } =>
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value,
  localWorkspaceId: () => "local",
  workspaceOpenFolderDialog: vi.fn(),
  workspaceSetRoot: vi.fn(),
}));

vi.mock("../../src/lib/stores/tabs", () => ({
  openFile: vi.fn(),
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PLACEHOLDER = "Search across the project…";
const FILES_PLACEHOLDER = "Go to file…";

function results(matches: SearchResults["matches"], truncated = false): SearchResults {
  return { matches, truncated };
}

function fileResults(
  matches: FileSearchResults["matches"],
  truncated = false,
): FileSearchResults {
  return { matches, truncated };
}

describe("SearchOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    searchOverlay.set({ open: false, mode: "content" });
    workspace.set({ id: "local", root: "/proj" });
    dismissErrorToast();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("disables native browser autocomplete/spellcheck suggestions on the query input", async () => {
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });

  // `jsdom` (this test environment) already honors the bare `autofocus`
  // attribute on element insertion, so asserting on `document.activeElement`
  // alone would pass even without the imperative `.focus()`/`.select()`
  // calls the fix adds — giving false confidence against the real WebKit
  // failure mode the issue reports. Spying on
  // `HTMLInputElement.prototype.focus`/`.select()` instead asserts the
  // imperative call itself fired, which is what the fix actually adds.
  it("imperatively focuses and selects the query input on a fresh open in content mode", async () => {
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();
    await screen.findByPlaceholderText(PLACEHOLDER);

    expect(focusSpy).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalled();
  });

  it("imperatively focuses and selects the query input on a fresh open in files mode", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(fileResults([]));
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await screen.findByPlaceholderText(FILES_PLACEHOLDER);

    expect(focusSpy).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalled();
  });

  it("does not re-select the query input on a keystroke after a fresh open", async () => {
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "f" } });
    await tick();

    // The open/reset effect must not have rerun from this keystroke: a
    // re-fired `.select()` would leave the whole input selected ([0, 1]),
    // so the *next* character typed would replace "f" instead of appending.
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
  });

  it("imperatively focuses and selects the files-mode input when switching modes while already open", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(results([]));
    vi.mocked(commands.findFiles).mockResolvedValue(fileResults([]));
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();
    await screen.findByPlaceholderText(PLACEHOLDER);

    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await screen.findByPlaceholderText(FILES_PLACEHOLDER);

    expect(focusSpy).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalled();
  });

  it("does not render the panel until the overlay is opened", async () => {
    const { container } = render(SearchOverlay);
    expect(container.querySelector(".search-panel")).toBeNull();

    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    expect(container.querySelector(".search-panel")).not.toBeNull();
  });

  it("debounces typing before calling searchWorkspace", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(results([]));
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });

    expect(commands.searchWorkspace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);

    expect(commands.searchWorkspace).toHaveBeenCalledTimes(1);
    expect(commands.searchWorkspace).toHaveBeenCalledWith("local", "foo", {
      caseSensitive: false,
      regex: false,
    });
  });

  it("shows a loading spinner from the first qualifying keystroke through the debounce wait and the response, then hides it", async () => {
    const first = deferred<SearchResults>();
    vi.mocked(commands.searchWorkspace).mockReturnValueOnce(first.promise);

    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await tick();

    // Visible immediately, before the debounce timer has even fired. The
    // spinner element is always in the DOM, absolutely positioned over the
    // input's right edge, so its appearing/disappearing never shifts the
    // input's text — visibility is a CSS class, not DOM presence.
    expect(container.querySelector(".search-spinner.visible")).not.toBeNull();

    const wrapper = container.querySelector(".search-input-wrapper");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector("input")).not.toBeNull();
    expect(wrapper!.querySelector(".search-spinner")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(150);
    // Still visible while the backend call is in flight.
    expect(container.querySelector(".search-spinner.visible")).not.toBeNull();

    first.resolve(results([]));
    await tick();
    await tick();

    expect(container.querySelector(".search-spinner.visible")).toBeNull();
  });

  it("does not show a loading spinner for a query below the minimum length", async () => {
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "fo" } });
    await tick();
    await vi.advanceTimersByTimeAsync(150);

    expect(container.querySelector(".search-spinner.visible")).toBeNull();
  });

  it("does not search below the minimum query length, and shows a hint instead", async () => {
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "fo" } });
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.searchWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByText("Type at least 3 characters to search")).toBeTruthy();

    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.searchWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not fire a spurious content-mode search on an empty-query reopen in the same mode", async () => {
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);

    // Close without typing, then reopen in the same mode: `scheduleSearch()`
    // fires imperatively from the open/reset effect (issue #327's fix), but
    // content mode's own minimum-query-length gate must still suppress the
    // actual backend call for an empty query, exactly as it does on a fresh
    // first open.
    searchOverlay.set({ open: false, mode: "content" });
    await tick();
    searchOverlay.set({ open: true, mode: "content" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.searchWorkspace).not.toHaveBeenCalled();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.searchWorkspace).toHaveBeenCalledTimes(1);
  });

  it("discards a search response that resolves after the query was cleared or shortened below the minimum", async () => {
    const first = deferred<SearchResults>();
    vi.mocked(commands.searchWorkspace).mockReturnValueOnce(first.promise);

    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(commands.searchWorkspace).toHaveBeenCalledTimes(1);

    // The user clears the query before the in-flight "foo" search resolves.
    await fireEvent.input(input, { target: { value: "" } });
    await vi.advanceTimersByTimeAsync(150);

    first.resolve(
      results([
        { path: "/proj/a.txt", line: 1, column: 1, lineText: "foo", matchStart: 0, matchEnd: 3 },
      ]),
    );
    await tick();

    // The stale "foo" response must not repopulate results now that the
    // query is empty again.
    expect(screen.queryByText("a.txt")).toBeNull();
    expect(screen.queryByText(/result/)).toBeNull();
  });

  it("re-fires a query with updated options when a toggle changes", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(results([]));
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(commands.searchWorkspace).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByLabelText("Match case"));
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.searchWorkspace).toHaveBeenCalledTimes(2);
    expect(commands.searchWorkspace).toHaveBeenLastCalledWith("local", "foo", {
      caseSensitive: true,
      regex: false,
    });
  });

  it("discards a stale response that resolves after a newer one", async () => {
    const first = deferred<SearchResults>();
    const second = deferred<SearchResults>();
    vi.mocked(commands.searchWorkspace)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);
    await fireEvent.input(input, { target: { value: "foobar" } });
    await vi.advanceTimersByTimeAsync(150);

    // Resolve the newer (second) query before the older (first) one.
    second.resolve(
      results([
        { path: "/proj/b.txt", line: 2, column: 1, lineText: "foobar", matchStart: 0, matchEnd: 6 },
      ]),
    );
    await tick();
    first.resolve(
      results([
        { path: "/proj/a.txt", line: 1, column: 1, lineText: "foo", matchStart: 0, matchEnd: 3 },
      ]),
    );
    await tick();

    expect(await screen.findByText("b.txt")).toBeTruthy();
    expect(screen.queryByText("a.txt")).toBeNull();
  });

  it("Enter jumps to the selected result via openFile and closes the overlay", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(
      results([
        { path: "/proj/a.txt", line: 3, column: 5, lineText: "foo bar", matchStart: 0, matchEnd: 3 },
      ]),
    );
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("a.txt");

    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();

    expect(tabsStore.openFile).toHaveBeenCalledWith("/proj/a.txt", { line: 3, col: 5 });
    expect(get(searchOverlay).open).toBe(false);
  });

  it("clicking a result calls openFile with its line/col and closes the overlay", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(
      results([
        { path: "/proj/a.txt", line: 7, column: 2, lineText: "needle here", matchStart: 0, matchEnd: 6 },
      ]),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "needle" } });
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("a.txt");

    const row = container.querySelector(".search-result-row");
    expect(row).not.toBeNull();
    await fireEvent.click(row!);
    await tick();

    expect(tabsStore.openFile).toHaveBeenCalledWith("/proj/a.txt", { line: 7, col: 2 });
    expect(get(searchOverlay).open).toBe(false);
  });

  it("Escape closes the overlay without calling openFile", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(
      results([
        { path: "/proj/a.txt", line: 1, column: 1, lineText: "foo", matchStart: 0, matchEnd: 3 },
      ]),
    );
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("a.txt");

    await fireEvent.keyDown(input, { key: "Escape" });
    await tick();

    expect(tabsStore.openFile).not.toHaveBeenCalled();
    expect(get(searchOverlay).open).toBe(false);
  });

  it("clicking the backdrop closes the overlay; clicking inside the panel does not", async () => {
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const panel = container.querySelector(".search-panel")!;
    await fireEvent.click(panel);
    await tick();
    expect(get(searchOverlay).open).toBe(true);

    const backdrop = container.querySelector(".search-backdrop")!;
    await fireEvent.click(backdrop);
    await tick();
    expect(get(searchOverlay).open).toBe(false);
  });

  it("renders the inline error state for an InvalidRegex rejection instead of an empty results list", async () => {
    vi.mocked(commands.searchWorkspace).mockRejectedValue({
      code: "INVALID_REGEX",
      message: "invalid regex: unterminated",
    });
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.click(screen.getByLabelText("Use regular expression"));
    await fireEvent.input(input, { target: { value: "(unterminated" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();

    expect(await screen.findByText("invalid regex: unterminated")).toBeTruthy();
    expect(container.querySelector(".search-empty")).toBeNull();
  });

  it("renders the inline error state for a non-regex AppError in content mode instead of an empty results list", async () => {
    vi.mocked(commands.searchWorkspace).mockRejectedValue({
      code: "IO_ERROR",
      message: "failed to read directory",
    });
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "needle" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();

    expect(await screen.findByText("failed to read directory")).toBeTruthy();
    expect(container.querySelector(".search-empty")).toBeNull();
  });

  it("renders the inline error state in files mode instead of an empty results list", async () => {
    vi.mocked(commands.findFiles).mockRejectedValue({
      code: "IO_ERROR",
      message: "failed to walk workspace",
    });
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();

    const input = await screen.findByPlaceholderText(FILES_PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "needle" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();

    expect(await screen.findByText("failed to walk workspace")).toBeTruthy();
    expect(screen.queryByText("No matching files")).toBeNull();
  });

  it("logs to the console for a non-regex content-mode failure and for any files-mode failure, but not for INVALID_REGEX", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(commands.searchWorkspace).mockRejectedValue({
      code: "INVALID_REGEX",
      message: "invalid regex: unterminated",
    });
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();
    await fireEvent.click(screen.getByLabelText("Use regular expression"));
    const contentInput = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(contentInput, { target: { value: "(unterminated" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();
    await screen.findByText("invalid regex: unterminated");

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    cleanup();

    vi.mocked(commands.searchWorkspace).mockRejectedValue({
      code: "IO_ERROR",
      message: "failed to read directory",
    });
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();
    const nonRegexInput = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(nonRegexInput, { target: { value: "needle" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();
    await screen.findByText("failed to read directory");

    expect(consoleErrorSpy).toHaveBeenCalledWith("atrium: search failed", {
      code: "IO_ERROR",
      message: "failed to read directory",
    });
    consoleErrorSpy.mockClear();
    cleanup();

    vi.mocked(commands.findFiles).mockRejectedValue({
      code: "IO_ERROR",
      message: "failed to walk workspace",
    });
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    const filesInput = await screen.findByPlaceholderText(FILES_PLACEHOLDER);
    await fireEvent.input(filesInput, { target: { value: "needle" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();
    await screen.findByText("failed to walk workspace");

    expect(consoleErrorSpy).toHaveBeenCalledWith("atrium: find files failed", {
      code: "IO_ERROR",
      message: "failed to walk workspace",
    });
  });

  it("does not fire a toast for content-mode or files-mode inline search errors", async () => {
    vi.mocked(commands.searchWorkspace).mockRejectedValue({
      code: "INVALID_REGEX",
      message: "invalid regex: unterminated",
    });
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();
    await fireEvent.click(screen.getByLabelText("Use regular expression"));
    const regexInput = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(regexInput, { target: { value: "(unterminated" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();
    await screen.findByText("invalid regex: unterminated");
    expect(get(errorToast)).toBeNull();

    vi.mocked(commands.searchWorkspace).mockRejectedValue({
      code: "IO_ERROR",
      message: "failed to read directory",
    });
    await fireEvent.input(regexInput, { target: { value: "needle" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();
    await screen.findByText("failed to read directory");
    expect(get(errorToast)).toBeNull();

    vi.mocked(commands.findFiles).mockRejectedValue({
      code: "IO_ERROR",
      message: "failed to walk workspace",
    });
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    const filesInput = await screen.findByPlaceholderText(FILES_PLACEHOLDER);
    await fireEvent.input(filesInput, { target: { value: "needle" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();
    await screen.findByText("failed to walk workspace");
    expect(get(errorToast)).toBeNull();
  });

  it("has no in-panel control to switch modes — Content and Files are exclusive views", async () => {
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    expect(container.querySelector(".search-mode-tabs")).toBeNull();
    expect(screen.queryByText("Files")).toBeNull();
  });

  it("switching to Files mode via its exclusive shortcut while Content mode is open fully resets state (not an in-place toggle)", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(results([]));
    vi.mocked(commands.findFiles).mockResolvedValue(fileResults([]));
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "content" });
    await tick();

    const contentInput = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.input(contentInput, { target: { value: "over" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(commands.searchWorkspace).toHaveBeenCalledTimes(1);

    // Cmd/Ctrl+P firing while the content view is open — as if from
    // `main.rs`'s exclusive Go to File menu item, via `openSearch("files")`.
    searchOverlay.set({ open: true, mode: "files" });
    await tick();

    const filesInput = await screen.findByPlaceholderText(FILES_PLACEHOLDER);
    // The content query is not carried over: each mode is a fully separate,
    // exclusive view, not a toggle that preserves what was typed.
    expect((filesInput as HTMLInputElement).value).toBe("");
    expect(get(searchOverlay).mode).toBe("files");
  });

  it("searches in Files mode even with a query shorter than the minimum content-mode length", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(fileResults([]));
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();

    const input = await screen.findByPlaceholderText(FILES_PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "ab" } });
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.findFiles).toHaveBeenCalledWith("local", "ab");
  });

  it("fires a findFiles request for an empty query in Files mode (browsing behavior)", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([{ path: "/proj/a.txt", displayPath: "a.txt", score: 0, matchIndices: [] }]),
    );
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.findFiles).toHaveBeenCalledWith("local", "");
    expect(await screen.findByText("a.txt")).toBeTruthy();
  });

  it("fires a second findFiles request and shows the browse list again on reopen in the same mode (issue #327)", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([{ path: "/proj/a.txt", displayPath: "a.txt", score: 0, matchIndices: [] }]),
    );
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.findFiles).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("a.txt")).toBeTruthy();

    // Close without typing anything, then reopen in the same mode: `query`
    // and `mode` are both already at their post-reset values, so nothing
    // about them actually changes value on this second open.
    searchOverlay.set({ open: false, mode: "files" });
    await tick();
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);

    expect(commands.findFiles).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("a.txt")).toBeTruthy();
  });

  it("shows recently-opened files first in the empty-query Files-mode browse list", async () => {
    recordFileOpened("/proj", "/proj/c.txt");
    recordFileOpened("/proj", "/proj/a.txt");
    // Most recent first: a.txt was opened after c.txt.
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([
        { path: "/proj/a.txt", displayPath: "a.txt", score: 0, matchIndices: [] },
        { path: "/proj/b.txt", displayPath: "b.txt", score: 0, matchIndices: [] },
        { path: "/proj/c.txt", displayPath: "c.txt", score: 0, matchIndices: [] },
      ]),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("a.txt");

    const names = Array.from(container.querySelectorAll(".search-result-filename")).map((el) =>
      el.textContent?.trim(),
    );
    // a.txt (most recent) and c.txt (less recent) come first, in recency
    // order; b.txt (never opened) falls back after them in its original
    // (alphabetical) position.
    expect(names).toEqual(["a.txt", "c.txt", "b.txt"]);
  });

  it("does not reorder Files-mode results by recency once a query is typed", async () => {
    recordFileOpened("/proj", "/proj/b.txt");
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([
        { path: "/proj/a.txt", displayPath: "a.txt", score: 20, matchIndices: [] },
        { path: "/proj/b.txt", displayPath: "b.txt", score: 10, matchIndices: [] },
      ]),
    );
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();

    const input = await screen.findByPlaceholderText(FILES_PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "txt" } });
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("a.txt");

    const names = Array.from(document.querySelectorAll(".search-result-filename")).map((el) =>
      el.textContent?.trim(),
    );
    // The backend's relevance ranking (a.txt first) is left untouched, even
    // though b.txt is the more-recently-opened file.
    expect(names).toEqual(["a.txt", "b.txt"]);
  });

  it("surfaces a recorded-recent file that findFiles' own result set omits (e.g. hidden/gitignored)", async () => {
    // Mirrors what the real backend does for a file like `.gitignore`: it's
    // outside `find_files`' walk universe, so it never appears in `matches`,
    // even though it was just opened from the explorer and recorded.
    recordFileOpened("/proj", "/proj/.gitignore");
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([{ path: "/proj/a.txt", displayPath: "a.txt", score: 0, matchIndices: [] }]),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("a.txt");

    const names = Array.from(container.querySelectorAll(".search-result-filename")).map((el) =>
      el.textContent?.trim(),
    );
    expect(names).toEqual([".gitignore", "a.txt"]);
  });

  it("surfaces a recorded-recent file that findFiles omitted for being past its 200-entry cap", async () => {
    recordFileOpened("/proj", "/proj/tests/frontend/tabs.test.ts");
    // The backend truncates before the frontend ever sees the list; the
    // recorded file simply isn't in `matches`, same shape as the universe
    // mismatch above but with `truncated: true`.
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([{ path: "/proj/a.txt", displayPath: "a.txt", score: 0, matchIndices: [] }], true),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("tabs.test.ts");

    const names = Array.from(container.querySelectorAll(".search-result-filename")).map((el) =>
      el.textContent?.trim(),
    );
    expect(names).toEqual(["tabs.test.ts", "a.txt"]);
  });

  it("orders recents by true recency across present and missing files alike, not by which group each falls into", async () => {
    // a.txt is the more-recently-opened file and findFiles does return it;
    // old-missing.txt is older and, like the universe-mismatch case above,
    // absent from findFiles' own result set. The present-but-newer file must
    // still lead — bucketing "missing" ahead of "present" regardless of
    // actual recency was the bug.
    recordFileOpened("/proj", "/proj/old-missing.txt");
    recordFileOpened("/proj", "/proj/a.txt");
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([
        { path: "/proj/a.txt", displayPath: "a.txt", score: 0, matchIndices: [] },
        { path: "/proj/b.txt", displayPath: "b.txt", score: 0, matchIndices: [] },
      ]),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("a.txt");

    const names = Array.from(container.querySelectorAll(".search-result-filename")).map((el) =>
      el.textContent?.trim(),
    );
    expect(names).toEqual(["a.txt", "old-missing.txt", "b.txt"]);
  });

  it("shows an error toast, prunes a stale recorded-recent file when opening it fails, and drops its row", async () => {
    recordFileOpened("/proj", "/proj/deleted.txt");
    vi.mocked(commands.findFiles).mockResolvedValue(fileResults([]));
    vi.mocked(tabsStore.openFile).mockRejectedValue(new Error("No such file or directory"));
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("deleted.txt");

    const row = container.querySelector(".search-result-row");
    expect(row).not.toBeNull();
    await fireEvent.click(row!);
    await tick();

    expect(get(errorToast)).toBe("Couldn't open file: No such file or directory");
    expect(getRecentFiles("/proj")).toEqual([]);
    // The overlay stays open (the user gets to see the toast and try
    // something else) rather than closing on a failed open — but the dead
    // row itself is gone, so re-clicking the same spot can't just re-toast.
    expect(get(searchOverlay).open).toBe(true);
    expect(screen.queryByText("deleted.txt")).toBeNull();
  });

  it("hides the case-sensitivity/regex toggles in Files mode", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(fileResults([]));
    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();

    expect(screen.queryByLabelText("Match case")).toBeNull();
    expect(screen.queryByLabelText("Use regular expression")).toBeNull();
  });

  it("selecting a file result calls openFile with no selection argument and closes the overlay", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([
        { path: "/proj/SearchOverlay.svelte", displayPath: "src/lib/search/SearchOverlay.svelte", score: 100, matchIndices: [0, 1] },
      ]),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("SearchOverlay.svelte", { exact: false });

    const row = container.querySelector(".search-result-row");
    expect(row).not.toBeNull();
    await fireEvent.click(row!);
    await tick();

    expect(tabsStore.openFile).toHaveBeenCalledWith("/proj/SearchOverlay.svelte");
    expect(get(searchOverlay).open).toBe(false);
  });

  it("renders a file result's filename and directory in separate elements, with the filename never truncated", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([
        {
          path: "/proj/src/lib/search/SearchOverlay.svelte",
          displayPath: "src/lib/search/SearchOverlay.svelte",
          score: 100,
          matchIndices: [],
        },
      ]),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("SearchOverlay.svelte");

    const filename = container.querySelector(".search-result-filename");
    const dir = container.querySelector(".search-result-dir");
    expect(filename?.textContent?.trim()).toBe("SearchOverlay.svelte");
    expect(dir?.textContent?.trim()).toBe("src/lib/search");
    // The filename has no `overflow`/`text-overflow` styling of its own, so
    // it's never the element that gets cut off by an ellipsis — only the
    // directory span (`.search-result-dir`, styled to truncate) can be.
  });

  it("renders a root-level file result (no directory) with just the filename", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(
      fileResults([{ path: "/proj/README.md", displayPath: "README.md", score: 0, matchIndices: [] }]),
    );
    const { container } = render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await screen.findByText("README.md");

    expect(container.querySelector(".search-result-filename")?.textContent?.trim()).toBe("README.md");
    expect(container.querySelector(".search-result-dir")).toBeNull();
  });

  it("discards a stale Files-mode response that resolves after a newer one", async () => {
    const first = deferred<FileSearchResults>();
    const second = deferred<FileSearchResults>();
    vi.mocked(commands.findFiles).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(SearchOverlay);
    searchOverlay.set({ open: true, mode: "files" });
    await tick();

    const input = await screen.findByPlaceholderText(FILES_PLACEHOLDER);
    await fireEvent.input(input, { target: { value: "foo" } });
    await vi.advanceTimersByTimeAsync(150);
    await fireEvent.input(input, { target: { value: "foobar" } });
    await vi.advanceTimersByTimeAsync(150);

    second.resolve(
      fileResults([{ path: "/proj/foobar.txt", displayPath: "foobar.txt", score: 10, matchIndices: [] }]),
    );
    await tick();
    first.resolve(
      fileResults([{ path: "/proj/foo.txt", displayPath: "foo.txt", score: 10, matchIndices: [] }]),
    );
    await tick();

    expect(await screen.findByText("foobar.txt")).toBeTruthy();
    expect(screen.queryByText("foo.txt")).toBeNull();
  });

  it("openSearch(\"files\") sets the store's mode to files, and the component picks it up on open", async () => {
    vi.mocked(commands.findFiles).mockResolvedValue(fileResults([]));
    render(SearchOverlay);

    searchOverlay.set({ open: true, mode: "files" });
    await tick();

    expect(get(searchOverlay).mode).toBe("files");
    expect(await screen.findByPlaceholderText(FILES_PLACEHOLDER)).toBeTruthy();
  });
});
