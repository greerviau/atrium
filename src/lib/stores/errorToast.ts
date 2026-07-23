import { writable } from "svelte/store";
import { isAppError } from "../ipc/commands";

const AUTO_DISMISS_MS = 5000;

/**
 * A single-slot error surface for fire-and-forget IPC calls with nowhere
 * else to report a failure (no dialog, no owning Svelte component instance).
 * `null` means no toast is showing. A second `showErrorToast` call while one
 * is already visible replaces the message and restarts the timer rather
 * than queuing — these failures are low-frequency and not expected to
 * overlap.
 */
export const errorToast = writable<string | null>(null);

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showErrorToast(message: string): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  errorToast.set(message);
  dismissTimer = setTimeout(dismissErrorToast, AUTO_DISMISS_MS);
}

export function dismissErrorToast(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  errorToast.set(null);
}

/**
 * Shared by the fire-and-forget IPC call sites (link-open failures) that
 * report through this toast. `UnsavedChangesDialog.svelte` and
 * `SettingsDialog.svelte` each keep their own copy for a locally-owned error
 * message rather than importing this one, to stay independent of the toast.
 */
export function describeError(err: unknown): string {
  if (isAppError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return "an unknown error";
}
