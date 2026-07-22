<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { SearchAddon } from "@xterm/addon-search";
  import "@xterm/xterm/css/xterm.css";
  import { ptySpawn, ptySubscribe, ptyWrite, ptyResize, ptyKill } from "../ipc/commands";
  import { registerLinkProviders } from "./linkProviders";
  import { theme as themeStore } from "../stores/theme";
  import { buildXtermTheme } from "../theme/xtermTheme";
  import { zoom } from "../stores/textSize";
  import { computeTabTitle, parseOsc7Cwd, reduceTitleState, type TitleState } from "./tabTitle";
  import { handleTerminalKeyEvent } from "./terminalKeyHandling";
  import { shellQuotePath } from "./shellQuote";
  import { EXPLORER_PATH_DRAG_TYPE } from "../util/dragDropTypes";

  // Tauri's `CmdOrCtrl` accelerator resolves to Cmd-only on macOS and
  // Ctrl-only elsewhere (never both on one platform), so the toggle-panel
  // guard below must match whichever modifier the native menu actually
  // bound on this platform — otherwise it would also swallow the shell's
  // own Ctrl+B/Ctrl+R readline bindings on macOS, where those are unbound.
  const isMacPlatform = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  // The pre-zoom hardcoded font size, kept as the 100% baseline the zoom level scales from.
  const BASE_TERMINAL_FONT_SIZE = 13;

  let {
    cwd,
    workspaceId,
    onExit,
    onTitleChange,
  }: {
    cwd: string;
    workspaceId: string;
    onExit?: (elapsedMs: number) => void;
    onTitleChange?: (title: string) => void;
  } = $props();

  let container: HTMLDivElement;
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let terminalId: string | undefined;
  let resizeObserver: ResizeObserver;
  let osc7Disposable: { dispose(): void };
  let osc133Disposable: { dispose(): void };
  let titleChangeDisposable: { dispose(): void };

  let titleState: TitleState;
  let lastEmittedTitle: string | undefined;
  let dropTargetActive = $state(false);

  function dispatch(event: Parameters<typeof reduceTitleState>[1]): void {
    titleState = reduceTitleState(titleState, event);
    const title = computeTabTitle(titleState);
    if (title !== lastEmittedTitle) {
      lastEmittedTitle = title;
      onTitleChange?.(title);
    }
  }

  function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function insertPathAtCursor(path: string): void {
    if (!terminalId) return;
    // terminal.paste() brackets the write only when the foreground program
    // has actually enabled bracketed-paste mode (DECSET 2004) — bracketing
    // unconditionally would leak the raw escape bytes into any program that
    // hasn't (`cat`, `sh`, the `node` REPL, `psql`, ...). It also routes
    // through the same terminal.onData -> ptyWrite wire below, so the
    // terminalId guard above is the only gate needed.
    // A trailing space means two dropped paths become two shell words
    // ("'/one/a' '/two/b'") instead of running together into one.
    terminal.paste(`${shellQuotePath(path)} `);
    terminal.focus();
  }

  function onDragOver(event: DragEvent): void {
    // Refuse the drop while the pty is still spawning rather than silently
    // swallowing it: with no preventDefault the browser never treats this
    // element as a valid drop target, so no "drop" event follows.
    if (!terminalId) return;
    if (!event.dataTransfer?.types.includes(EXPLORER_PATH_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dropTargetActive = true;
  }

  function onDragLeave(event: DragEvent): void {
    // `dragleave` bubbles from xterm's own child elements as the pointer
    // moves within the pane, so only clear the affordance once the pointer
    // has actually left the pane's subtree.
    if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return;
    dropTargetActive = false;
  }

  function onDrop(event: DragEvent): void {
    dropTargetActive = false;
    const path = event.dataTransfer?.getData(EXPLORER_PATH_DRAG_TYPE);
    if (!path) return;
    event.preventDefault();
    insertPathAtCursor(path);
  }

  onMount(() => {
    titleState = { cwd, commandRunning: false, processTitle: null };
    lastEmittedTitle = computeTabTitle(titleState);

    terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, monospace",
      fontSize: Math.round(BASE_TERMINAL_FONT_SIZE * get(zoom)),
      theme: buildXtermTheme($themeStore),
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new SearchAddon());
    terminal.open(container);
    fitAddon.fit();

    // Never forward Cmd/Ctrl+B or Cmd/Ctrl+R to the shell: xterm has no
    // native concept of "the menu accelerator already owns this key," so
    // without this guard a focused terminal would send Ctrl+R straight to
    // the pty as literal input, triggering the shell's reverse-i-search
    // instead of the panel toggle. `Cmd/Ctrl+\` (split-terminal) needs no
    // entry here: unlike B/R (real readline bindings) or Ctrl+D (shell EOF),
    // `\` has no shell/readline meaning on any platform this app targets, so
    // there's nothing for the guard to intercept it from. Also remaps a bare
    // Shift+Enter to the newline-not-submit sequence multi-line prompts
    // already recognize.
    terminal.attachCustomKeyEventHandler((event) =>
      handleTerminalKeyEvent(event, {
        isMacPlatform,
        writeToPty: (data) => {
          if (terminalId) void ptyWrite(terminalId, data);
        },
      }),
    );

    registerLinkProviders(terminal, workspaceId, cwd);

    osc7Disposable = terminal.parser.registerOscHandler(7, (data) => {
      const parsedCwd = parseOsc7Cwd(data);
      if (parsedCwd) {
        dispatch({ type: "cwd", cwd: parsedCwd });
      }
      return true;
    });

    osc133Disposable = terminal.parser.registerOscHandler(133, (data) => {
      if (data.startsWith("C")) {
        dispatch({ type: "commandStart" });
      } else if (data.startsWith("D")) {
        dispatch({ type: "commandFinish" });
      }
      return true;
    });

    titleChangeDisposable = terminal.onTitleChange((title) => {
      dispatch({ type: "title", title });
    });

    terminal.onData((data) => {
      if (terminalId) {
        void ptyWrite(terminalId, data);
      }
    });

    (async () => {
      const cols = terminal.cols;
      const rows = terminal.rows;
      terminalId = await ptySpawn(cwd, cols, rows);
      // Captured after ptySpawn resolves (not before) so the elapsed time
      // measures the pty's own lifetime, not this call's IPC round-trip;
      // performance.now() is monotonic, unlike Date.now(), so a backwards
      // wall-clock correction can't produce a negative elapsed value.
      const spawnedAt = performance.now();
      await ptySubscribe(terminalId, (event) => {
        if (event.type === "data") {
          terminal.write(base64ToBytes(event.data));
        } else if (event.type === "exit") {
          onExit?.(performance.now() - spawnedAt);
        }
      });
    })();

    resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (terminalId) {
        void ptyResize(terminalId, terminal.cols, terminal.rows);
      }
    });
    resizeObserver.observe(container);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    osc7Disposable?.dispose();
    osc133Disposable?.dispose();
    titleChangeDisposable?.dispose();
    if (terminalId) {
      void ptyKill(terminalId);
    }
    terminal?.dispose();
  });

  // xterm.js applies a `theme` option change live, no Terminal recreation needed.
  $effect(() => {
    const current = $themeStore;
    if (terminal) {
      terminal.options.theme = buildXtermTheme(current);
    }
  });

  // A font-size change needs the same recompute-then-notify-the-pty sequence
  // as a container resize: fitAddon.fit() recalculates rows/cols for the new
  // cell size, then ptyResize tells the pty about the new dimensions.
  $effect(() => {
    const current = $zoom;
    if (terminal && fitAddon) {
      terminal.options.fontSize = Math.round(BASE_TERMINAL_FONT_SIZE * current);
      fitAddon.fit();
      if (terminalId) {
        void ptyResize(terminalId, terminal.cols, terminal.rows);
      }
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="terminal-pane"
  class:drop-target-active={dropTargetActive}
  bind:this={container}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
></div>

<style>
  .terminal-pane {
    height: 100%;
    width: 100%;
    padding: 4px;
    box-sizing: border-box;
    outline: 2px solid transparent;
    outline-offset: -2px;
  }

  .terminal-pane.drop-target-active {
    outline-color: var(--atrium-accent);
  }

  .terminal-pane :global(.xterm-viewport) {
    scrollbar-width: thin;
    scrollbar-color: var(--atrium-border) transparent;
  }
  .terminal-pane :global(.xterm-viewport::-webkit-scrollbar) {
    width: 10px;
  }
  .terminal-pane :global(.xterm-viewport::-webkit-scrollbar-track) {
    background: transparent;
  }
  .terminal-pane :global(.xterm-viewport::-webkit-scrollbar-thumb) {
    background-color: var(--atrium-border);
    border-radius: 5px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  .terminal-pane :global(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
    background-color: var(--atrium-text-muted);
  }
</style>
