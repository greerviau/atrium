import { invoke, Channel } from "@tauri-apps/api/core";
import { canonicalizePath } from "../util/path";

/**
 * The only place in the frontend that knows Tauri's `invoke()` API exists.
 * Every other module imports typed functions from here, so the IPC contract
 * is enforced by TypeScript types in one file rather than scattered
 * `invoke('some_string', ...)` calls with ad-hoc payload shapes.
 *
 * This is also the frontend's normalization boundary: every path-typed
 * field returned from Rust is folded through `canonicalizePath` here before
 * it reaches any store, so downstream code can rely on the canonical form
 * (see `src/lib/util/path.ts`'s module header). `findFiles`' `displayPath`
 * is the one deliberate exception — a display contract, never an identity
 * key. Paths sent *to* Rust are never normalized outbound: Rust already
 * accepts `/`-separated paths on Windows, and adding a second conversion
 * would only be a fresh chance to get it wrong.
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

export async function workspaceOpenFolderDialog(): Promise<string | null> {
  const path = await invoke<string | null>("workspace_open_folder_dialog");
  return path === null ? null : canonicalizePath(path);
}

export function workspaceSetRoot(workspaceId: string, path: string): Promise<void> {
  return invoke("workspace_set_root", { workspaceId, path });
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export async function workspaceGetRecents(): Promise<RecentProject[]> {
  const recents = await invoke<RecentProject[]>("workspace_get_recents");
  return recents.map((r) => ({ ...r, path: canonicalizePath(r.path) }));
}

export function workspaceRemoveRecent(path: string): Promise<void> {
  return invoke("workspace_remove_recent", { path });
}

/** Drains every pending path supplied by an OS open event or process launch argument. */
export async function workspaceTakePendingOpen(): Promise<string[]> {
  const paths = await invoke<string[]>("workspace_take_pending_open");
  return paths.map(canonicalizePath);
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

export async function gitGetContext(path: string): Promise<GitContext | null> {
  const context = await invoke<GitContext | null>("git_get_context", { path });
  if (!context) return null;
  return {
    ...context,
    repositoryRoot: canonicalizePath(context.repositoryRoot),
    worktreePath: canonicalizePath(context.worktreePath),
    worktrees: context.worktrees.map((w) => ({ ...w, path: canonicalizePath(w.path) })),
    branches: context.branches.map((b) => ({
      ...b,
      worktreePath: b.worktreePath === null ? null : canonicalizePath(b.worktreePath),
    })),
  };
}

export function gitSwitchBranch(path: string, branch: string): Promise<void> {
  return invoke("git_switch_branch", { path, branch });
}

export async function fsListDir(workspaceId: string, path: string): Promise<DirEntry[]> {
  const entries = await invoke<DirEntry[]>("fs_list_dir", { workspaceId, path });
  return entries.map((e) => ({ ...e, path: canonicalizePath(e.path) }));
}

export function fsReadFile(workspaceId: string, path: string): Promise<string> {
  return invoke("fs_read_file", { workspaceId, path });
}

/** Checks that `path` is an existing regular file readable through `workspaceId`, without transferring its contents. */
export function fsCheckFileAccess(workspaceId: string, path: string): Promise<void> {
  return invoke("fs_check_file_access", { workspaceId, path });
}

export interface DataQueryResult {
  columns: string[];
  rows: Array<Array<string | null>>;
  totalRows: number;
  truncated: boolean;
}

export function dataQuery(
  workspaceId: string,
  path: string,
  query: string,
  page: number,
  pageSize: number | null,
): Promise<DataQueryResult> {
  return invoke("data_query", { workspaceId, path, query, page, pageSize });
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

/** One resolved terminal file-path link. `external` marks a file outside the workspace root (or resolved with no root at all), which needs a grant before it can be opened. */
export interface ResolvedPath {
  path: string;
  external: boolean;
}

export async function fsResolveCandidates(
  workspaceId: string,
  candidates: PathCandidate[],
): Promise<(ResolvedPath | null)[]> {
  const resolved = await invoke<(ResolvedPath | null)[]>("fs_resolve_candidates", {
    workspaceId,
    candidates,
  });
  return resolved.map((r) => (r === null ? null : { ...r, path: canonicalizePath(r.path) }));
}

/** One authorized terminal link: the path to open, and the workspace whose grant authorizes it — which is the workspace the file must be read through. */
export interface AuthorizedLink {
  path: string;
  workspaceId: string;
}

/** Resolves one terminal link at activation time, creating the external-file grant that makes it readable. Called only for a link resolution reported as `external`; it is the only path by which a terminal link produces a grant. */
export async function fsAuthorizeTerminalLink(
  workspaceId: string,
  candidate: PathCandidate,
): Promise<AuthorizedLink> {
  const link = await invoke<AuthorizedLink>("fs_authorize_terminal_link", { workspaceId, candidate });
  return { ...link, path: canonicalizePath(link.path) };
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

export async function searchWorkspace(
  workspaceId: string,
  query: string,
  options: SearchOptions,
): Promise<SearchResults> {
  const results = await invoke<SearchResults>("search_workspace", { workspaceId, query, options });
  return { ...results, matches: results.matches.map((m) => ({ ...m, path: canonicalizePath(m.path) })) };
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

/** `displayPath` is deliberately left un-normalized: it's a display contract (`find_files`' `display_path`), never an identity key — see `src/lib/util/path.ts`'s module header. */
export async function findFiles(workspaceId: string, query: string): Promise<FileSearchResults> {
  const results = await invoke<FileSearchResults>("find_files", { workspaceId, query });
  return { ...results, matches: results.matches.map((m) => ({ ...m, path: canonicalizePath(m.path) })) };
}

export function ptySpawn(cwd: string, cols: number, rows: number): Promise<string> {
  return invoke("pty_spawn", { cwd, cols, rows });
}

export function ptySubscribe(
  terminalId: string,
  onEvent: (event: PtyEvent) => void,
): Promise<void> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    onEvent(event.type === "title" ? { ...event, cwd: canonicalizePath(event.cwd) } : event);
  };
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
