import { writable } from "svelte/store";
import {
  workspaceGetRecents,
  workspaceRemoveRecent,
  workspaceClearRecents,
  type RecentProject,
} from "../ipc/commands";

/**
 * The recent-projects list, shared between `WelcomeScreen` (the only place
 * it's shown) and the settings dialog (the only place it can be bulk-cleared)
 * so removing or clearing an entry from either surface is immediately
 * reflected on the other, rather than each keeping its own local copy.
 */
export const recents = writable<RecentProject[]>([]);

export async function loadRecents(): Promise<void> {
  recents.set(await workspaceGetRecents());
}

export async function removeRecent(path: string): Promise<void> {
  await workspaceRemoveRecent(path);
  recents.update((list) => list.filter((r) => r.path !== path));
}

export async function clearRecents(): Promise<void> {
  await workspaceClearRecents();
  recents.set([]);
}
