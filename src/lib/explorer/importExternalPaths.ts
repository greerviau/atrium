import { fsImportExternalPaths, localWorkspaceId } from "../ipc/commands";
import { loadChildren } from "../stores/fileTree";

/** Imports each OS path in `sourcePaths` into `dirPath`, matching `contextMenu.ts`'s established pattern for a mutation: call the `fs*` IPC command, then explicitly reload the affected directory rather than waiting on the debounced `fs:changed` watcher. */
export async function importPathsInto(dirPath: string, sourcePaths: string[]): Promise<void> {
  await fsImportExternalPaths(localWorkspaceId(), dirPath, sourcePaths);
  await loadChildren(dirPath);
}
