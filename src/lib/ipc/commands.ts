import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * The only place in the frontend that knows Tauri's `invoke()` API exists.
 * Every other module imports typed functions from here, so the IPC contract
 * is enforced by TypeScript types in one file rather than scattered
 * `invoke('some_string', ...)` calls with ad-hoc payload shapes.
 */

export interface AppError {
  code: string;
  message: string;
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value
  );
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
}

export interface PathCandidate {
  raw: string;
  cwdHint: string;
}

export type PtyEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "title"; cwd: string; program: string | null };

const LOCAL_WORKSPACE_ID = "local";
const STANDALONE_WORKSPACE_ID = "standalone";

export function localWorkspaceId(): string {
  return LOCAL_WORKSPACE_ID;
}

/** The fixed id of the root-less workspace a file opened with no project open is read/written through — see `src-tauri/src/workspace/standalone.rs`. */
export function standaloneWorkspaceId(): string {
  return STANDALONE_WORKSPACE_ID;
}

export function workspaceOpenFolderDialog(): Promise<string | null> {
  return invoke("workspace_open_folder_dialog");
}

export function workspaceSetRoot(workspaceId: string, path: string): Promise<void> {
  return invoke("workspace_set_root", { workspaceId, path });
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export function workspaceGetRecents(): Promise<RecentProject[]> {
  return invoke("workspace_get_recents");
}

export function workspaceRemoveRecent(path: string): Promise<void> {
  return invoke("workspace_remove_recent", { path });
}

/** Drains every pending Dock-menu-picked (or OS "Open With Atrium") path from a cold launch, if any (macOS only). */
export function workspaceTakePendingOpen(): Promise<string[]> {
  return invoke("workspace_take_pending_open");
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;
  isCurrent: boolean;
}

export interface GitBranch {
  name: string;
  worktreePath: string | null;
  isCurrent: boolean;
}

export interface GitContext {
  repositoryRoot: string;
  worktreePath: string;
  branch: string | null;
  head: string;
  worktrees: GitWorktree[];
  branches: GitBranch[];
}

export function gitGetContext(path: string): Promise<GitContext | null> {
  return invoke("git_get_context", { path });
}

export function gitSwitchBranch(path: string, branch: string): Promise<void> {
  return invoke("git_switch_branch", { path, branch });
}

export function fsListDir(workspaceId: string, path: string): Promise<DirEntry[]> {
  return invoke("fs_list_dir", { workspaceId, path });
}

export function fsReadFile(workspaceId: string, path: string): Promise<string> {
  return invoke("fs_read_file", { workspaceId, path });
}

export interface DataQueryResult {
  columns: string[];
  rows: Array<Array<string | null>>;
  truncated: boolean;
}

export function dataQuery(
  workspaceId: string,
  path: string,
  query: string,
): Promise<DataQueryResult> {
  return invoke("data_query", { workspaceId, path, query });
}

export function fsWriteFile(
  workspaceId: string,
  path: string,
  contents: string,
): Promise<void> {
  return invoke("fs_write_file", { workspaceId, path, contents });
}

export function fsCreateFile(workspaceId: string, path: string): Promise<void> {
  return invoke("fs_create_file", { workspaceId, path });
}

export function fsCreateDir(workspaceId: string, path: string): Promise<void> {
  return invoke("fs_create_dir", { workspaceId, path });
}

export function fsRename(workspaceId: string, from: string, to: string): Promise<void> {
  return invoke("fs_rename", { workspaceId, from, to });
}

export function fsDelete(
  workspaceId: string,
  path: string,
  recursive: boolean,
): Promise<void> {
  return invoke("fs_delete", { workspaceId, path, recursive });
}

export function fsImportExternalPaths(
  workspaceId: string,
  destDir: string,
  sourcePaths: string[],
): Promise<void> {
  return invoke("fs_import_external_paths", { workspaceId, destDir, sourcePaths });
}

export function fsResolveCandidates(
  workspaceId: string,
  candidates: PathCandidate[],
): Promise<(string | null)[]> {
  return invoke("fs_resolve_candidates", { workspaceId, candidates });
}

/** Classifies each of `paths` as a directory (`true`) or not (`false`), following symlinks. */
export function fsExternalPathsAreDirs(paths: string[]): Promise<boolean[]> {
  return invoke("fs_external_paths_are_dirs", { paths });
}

/**
 * Authorizes direct read/write access to `path` (outside `workspaceId`'s
 * root) at its real, current location — the only way an external-file grant
 * is ever created. Gated server-side on a real, recent OS drop having landed
 * on this exact path; rejects otherwise.
 */
export function fsGrantExternalFile(workspaceId: string, path: string): Promise<void> {
  return invoke("fs_grant_external_file", { workspaceId, path });
}

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResults {
  matches: SearchMatch[];
  truncated: boolean;
}

export function searchWorkspace(
  workspaceId: string,
  query: string,
  options: SearchOptions,
): Promise<SearchResults> {
  return invoke("search_workspace", { workspaceId, query, options });
}

export interface FileMatch {
  path: string;
  displayPath: string;
  score: number;
  matchIndices: number[];
}

export interface FileSearchResults {
  matches: FileMatch[];
  truncated: boolean;
}

export function findFiles(workspaceId: string, query: string): Promise<FileSearchResults> {
  return invoke("find_files", { workspaceId, query });
}

export function ptySpawn(cwd: string, cols: number, rows: number): Promise<string> {
  return invoke("pty_spawn", { cwd, cols, rows });
}

export function ptySubscribe(
  terminalId: string,
  onEvent: (event: PtyEvent) => void,
): Promise<void> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke("pty_subscribe", { terminalId, channel });
}

export function ptyWrite(terminalId: string, data: string): Promise<void> {
  return invoke("pty_write", { terminalId, data });
}

export function ptyResize(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { terminalId, cols, rows });
}

export function ptyKill(terminalId: string): Promise<void> {
  return invoke("pty_kill", { terminalId });
}

export function shellOpenExternal(url: string): Promise<void> {
  return invoke("shell_open_external", { url });
}

export function openExternalLink(url: string): Promise<void> {
  return invoke("open_external_link", { url });
}

/** Confirms the app should actually close: kills running PTYs and exits. */
export function appConfirmClose(): Promise<void> {
  return invoke("app_confirm_close");
}
