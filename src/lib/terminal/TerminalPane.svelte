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
  }: { cwd: string; workspaceId: string; onExit?: () => void; onTitleChange?: (title: string) => void } = $props();

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
    // instead of the panel toggle.
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      const hasToggleModifier = isMacPlatform ? event.metaKey : event.ctrlKey && !event.metaKey;
      const isToggleAccelerator = hasToggleModifier && (key === "b" || key === "r");
      return !isToggleAccelerator;
    });

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
      await ptySubscribe(terminalId, (event) => {
        if (event.type === "data") {
          terminal.write(base64ToBytes(event.data));
        } else if (event.type === "exit") {
          onExit?.();
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

<div class="terminal-pane" bind:this={container}></div>

<style>
  .terminal-pane {
    height: 100%;
    width: 100%;
    padding: 4px;
    box-sizing: border-box;
  }
</style>
