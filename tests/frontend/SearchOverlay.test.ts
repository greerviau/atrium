import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import SearchOverlay from "../../src/lib/search/SearchOverlay.svelte";
import { searchOverlay } from "../../src/lib/search/searchOverlay";
import { workspace } from "../../src/lib/stores/workspace";
import * as commands from "../../src/lib/ipc/commands";
import * as tabsStore from "../../src/lib/stores/tabs";
import type { SearchResults } from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  searchWorkspace: vi.fn(),
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

function results(matches: SearchResults["matches"], truncated = false): SearchResults {
  return { matches, truncated };
}

describe("SearchOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    searchOverlay.set({ open: false });
    workspace.set({ id: "local", root: "/proj" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not render the panel until the overlay is opened", async () => {
    const { container } = render(SearchOverlay);
    expect(container.querySelector(".search-panel")).toBeNull();

    searchOverlay.set({ open: true });
    await tick();

    expect(container.querySelector(".search-panel")).not.toBeNull();
  });

  it("debounces typing before calling searchWorkspace", async () => {
    vi.mocked(commands.searchWorkspace).mockResolvedValue(results([]));
    render(SearchOverlay);
    searchOverlay.set({ open: true });
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

  it("does not search below the minimum query length, and shows a hint instead", async () => {
    render(SearchOverlay);
    searchOverlay.set({ open: true });
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

  it("discards a search response that resolves after the query was cleared or shortened below the minimum", async () => {
    const first = deferred<SearchResults>();
    vi.mocked(commands.searchWorkspace).mockReturnValueOnce(first.promise);

    render(SearchOverlay);
    searchOverlay.set({ open: true });
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
    searchOverlay.set({ open: true });
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
    searchOverlay.set({ open: true });
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
    searchOverlay.set({ open: true });
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
    searchOverlay.set({ open: true });
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
    searchOverlay.set({ open: true });
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
    searchOverlay.set({ open: true });
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
    searchOverlay.set({ open: true });
    await tick();

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fireEvent.click(screen.getByLabelText("Use regular expression"));
    await fireEvent.input(input, { target: { value: "(unterminated" } });
    await vi.advanceTimersByTimeAsync(150);
    await tick();

    expect(await screen.findByText("invalid regex: unterminated")).toBeTruthy();
    expect(container.querySelector(".search-empty")).toBeNull();
  });
});
