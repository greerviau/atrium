<script lang="ts">
  import { flip } from "svelte/animate";
  import type { LeafPane, SplitDirection } from "./paneTree";
  import TerminalPane from "./TerminalPane.svelte";
  import SplitMenu from "./SplitMenu.svelte";
  import TerminalIcon from "./icons/TerminalIcon.svelte";
  import { beginTabDrag, draggingTabKey, type TabDropTarget } from "../panes/tabDrag";

  /**
   * One leaf's full top bar (tab strip + controls) and its stack of
   * `TerminalPane` instances, one per session — `hidden` toggled by
   * `tree.activeTabId` so switching tabs within this panel never kills a
   * PTY. Every callback here is scoped to this leaf: the caller (`PaneSplit`)
   * binds `tree.id` via closures, so this component never needs to know its
   * own pane id beyond `tree.id` itself.
   */
  let {
    tree,
    workspaceId,
    visible = true,
    onSplit,
    onNewTab,
    onCloseTab,
    onSessionExit,
    onSetActiveTab,
    onTitleChange,
    onReorderTab = () => {},
    onDropTab = () => {},
  }: {
    tree: LeafPane;
    workspaceId: string;
    visible?: boolean;
    onSplit: (direction: SplitDirection) => void;
    onNewTab: () => void;
    // The tab's × button — a deliberate close.
    onCloseTab: (sessionId: string) => void;
    // The session's own PTY exiting, wired to TerminalPane's onExit below —
    // distinct from onCloseTab so a caller can tell a user-driven close
    // apart from the shell exiting on its own. elapsedMs is how long the
    // session had been alive when it exited.
    onSessionExit: (sessionId: string, elapsedMs: number) => void;
    onSetActiveTab: (sessionId: string) => void;
    onTitleChange: (sessionId: string, title: string) => void;
    onReorderTab?: (sessionId: string, toIndex: number) => void;
    onDropTab?: (sessionId: string, target: TabDropTarget) => void;
  } = $props();

  let tabListEl: HTMLDivElement | undefined = $state();
  let suppressClickSessionId = $state<string | null>(null);

  function onTabPointerDown(event: PointerEvent, sessionId: string): void {
    const target = event.target as HTMLElement;
    if (target.closest(".tab-close")) return;
    if (event.button !== 0 || !tabListEl) return;
    const session = tree.tabs.find((tab) => tab.id === sessionId);
    if (!session) return;
    beginTabDrag(
      event.currentTarget as HTMLElement,
      event,
      `${tree.id}:${sessionId}`,
      sessionId,
      () =>
        Array.from(tabListEl!.querySelectorAll<HTMLElement>(".tab[data-session-id]")).map((el) => ({
          path: el.dataset.sessionId!,
          rect: el.getBoundingClientRect(),
        })),
      (draggedSessionId, toIndex) => onReorderTab(draggedSessionId, toIndex),
      {
        surface: "terminal",
        paneId: tree.id,
        label: session.title,
        onDrop: (target) => onDropTab?.(sessionId, target),
        onDragEnd: (didDrag) => {
          suppressClickSessionId = didDrag ? sessionId : null;
        },
      },
    );
  }

  function onTabClick(sessionId: string): void {
    if (suppressClickSessionId === sessionId) {
      suppressClickSessionId = null;
      return;
    }
    onSetActiveTab(sessionId);
  }

  function onTabListWheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;
    const tabList = event.currentTarget as HTMLDivElement;
    tabList.scrollLeft += event.deltaY;
    event.preventDefault();
  }
</script>

<div class="terminal-panel">
  <div class="tab-strip">
    <div class="tab-list" bind:this={tabListEl} onwheel={onTabListWheel}>
      {#each tree.tabs as session (session.id)}
        <div
          class="tab"
          class:active={session.id === tree.activeTabId}
          class:dragging={$draggingTabKey === `${tree.id}:${session.id}`}
          data-session-id={session.id}
          onpointerdown={(e) => onTabPointerDown(e, session.id)}
          onclick={() => onTabClick(session.id)}
          onkeydown={(e) => e.key === "Enter" && onSetActiveTab(session.id)}
          role="tab"
          tabindex="0"
          aria-selected={session.id === tree.activeTabId}
          animate:flip={{ duration: $draggingTabKey === `${tree.id}:${session.id}` ? 0 : 150 }}
        >
          <TerminalIcon />
          <span class="tab-name" title={session.title}>{session.title}</span>
          <button
            class="tab-close"
            onclick={(e) => {
              e.stopPropagation();
              onCloseTab(session.id);
            }}
            aria-label="Close terminal"
          >
            ×
          </button>
        </div>
      {/each}
      <button class="tab new-tab" onclick={onNewTab}>+</button>
    </div>
    <div class="tab-strip-controls">
      <SplitMenu {onSplit} />
    </div>
  </div>
  <div class="terminal-panes">
    {#each tree.tabs as session (session.id)}
      <div class="terminal-pane-slot" class:hidden={session.id !== tree.activeTabId}>
        <TerminalPane
          cwd={session.cwd}
          sessionId={session.id}
          {workspaceId}
          visible={visible}
          active={session.id === tree.activeTabId}
          onExit={(elapsedMs) => onSessionExit(session.id, elapsedMs)}
          onTitleChange={(title) => onTitleChange(session.id, title)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .terminal-panel {
    height: 100%;
    width: 100%;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .tab-strip {
    display: flex;
    border-bottom: 1px solid var(--atrium-border);
    flex-shrink: 0;
  }

  .tab-list {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none; /* Firefox; inert on Atrium's WKWebView, harmless elsewhere */
  }
  .tab-list::-webkit-scrollbar {
    display: none; /* removes the bar entirely — unlike width/height: 0, this reserves no track space */
  }

  .tab-strip-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    flex-shrink: 0;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: none;
    border: none;
    border-right: 1px solid var(--atrium-border);
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
    touch-action: none;
  }

  .tab.active {
    background: var(--atrium-bg-active);
  }

  .tab.dragging {
    opacity: 0.2;
    cursor: grabbing;
    z-index: 1;
    position: relative;
  }

  .tab-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-close {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.6;
    padding: 0 2px;
  }

  .tab-close:hover {
    opacity: 1;
  }

  .terminal-panes {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .terminal-pane-slot {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .terminal-pane-slot.hidden {
    display: none;
  }
</style>
