/**
 * Opt-in tracing for the external-change chain behind issue #470: a file
 * deleted, renamed, or created outside Atrium has to travel
 * `fs_watch::watch` -> `app_handle.emit("fs:changed", ..)` -> `onFsChanged`
 * -> `App.svelte`'s handler -> `refreshDirectoryContaining` ->
 * `loadChildren` before an explorer row can change, and a break anywhere
 * along it looks identical from the UI: the row just stays.
 *
 * Three fixes have now been made against theories about *which* link breaks,
 * and the frontend half is pinned by regression tests at the real seam
 * (`tests/frontend/App.explorerExternalDelete.test.ts`), so the next
 * diagnosis needs the actual runtime payloads rather than another theory.
 * Every stage below reports what it saw, keyed by the same vocabulary the
 * code uses, so one reproduction produces enough to say exactly which link
 * dropped the change.
 *
 * Off unless explicitly switched on, so a dev-server session is not noisy by
 * default. To collect a trace, run this in the WebView console and reproduce:
 *
 *     localStorage.setItem("atrium.debug.fsChanges", "1")
 *
 * ...then reload. `console.info` (not `debug`) so the lines survive the
 * default console filter level.
 */

const STORAGE_KEY = "atrium.debug.fsChanges";

/**
 * Read once per session rather than per event: an `fs:changed` burst can be
 * hundreds of events, and this sits directly in that path. Switching the flag
 * takes effect on the next reload, which is also when the listener that emits
 * these is re-registered.
 */
let enabled: boolean | undefined;

function tracing(): boolean {
  if (enabled === undefined) {
    try {
      enabled = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      // A WebView with storage disabled must not take the fs:changed handler
      // down with it; tracing is a diagnostic, never a dependency.
      enabled = false;
    }
  }
  return enabled;
}

/** Stages of the chain, in the order a single external change passes through them. */
export type FsChangeStage =
  | "received" // onFsChanged, straight off the Tauri event, before canonicalization
  | "canonicalized" // what the handler actually sees
  | "routed" // App.svelte's workspace guard: accepted or rejected, and why
  | "resolved" // which tree node refreshDirectoryContaining picked, or none
  | "relisted" // what fs_list_dir returned for that node
  | "failed"; // the relist rejected

export function traceFsChange(stage: FsChangeStage, detail: Record<string, unknown>): void {
  if (!tracing()) return;
  // eslint-disable-next-line no-console
  console.info(`[atrium fs:changed] ${stage}`, detail);
}

/** Test seam: forces the flag, bypassing `localStorage`. */
export function setFsChangeTracingForTests(value: boolean | undefined): void {
  enabled = value;
}
