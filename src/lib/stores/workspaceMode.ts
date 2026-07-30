import { derived } from "svelte/store";
import { workspace } from "./workspace";
import { tabsState } from "./tabs";
import { standaloneWorkspaceId } from "../ipc/commands";

/**
 * True once the app is showing a single-file workspace: no project root
 * open, and at least one standalone (root-less) tab (issue #325). A new
 * module rather than living in `workspace.ts` or `tabs.ts`: those two
 * already form a deliberate import cycle, and a third module importing both
 * keeps that cycle from growing a second edge.
 */
export const isStandaloneWorkspace = derived(
  [workspace, tabsState],
  ([$workspace, $tabsState]) =>
    $workspace.root === null && $tabsState.tabs.some((t) => t.workspaceId === standaloneWorkspaceId()),
);
