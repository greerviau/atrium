import { writable } from "svelte/store";
import { workspaceGetRecents, workspaceRemoveRecent, type RecentProject } from "../ipc/commands";

/**
 * The recent-projects list, shared across `WelcomeScreen` and the title-bar
 * project switcher, so removing an entry from either surface is immediately
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
