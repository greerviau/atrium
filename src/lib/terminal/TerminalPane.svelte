<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { SearchAddon } from "@xterm/addon-search";
  import "@xterm/xterm/css/xterm.css";
  import { ptySpawn, ptySubscribe, ptyWrite, ptyResize, ptyKill } from "../ipc/commands";
  import { registerLinkProviders } from "./linkProviders";
  import { theme as themeStore } from "../stores/theme";
  import { buildXtermTheme } from "../theme/xtermTheme";

  let { cwd, workspaceId, onExit }: { cwd: string; workspaceId: string; onExit?: () => void } = $props();

  let container: HTMLDivElement;
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let terminalId: string | undefined;
  let resizeObserver: ResizeObserver;

  function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  onMount(() => {
    terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, monospace",
      fontSize: 13,
      theme: buildXtermTheme($themeStore),
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new SearchAddon());
    terminal.open(container);
    fitAddon.fit();

    registerLinkProviders(terminal, workspaceId, cwd);

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
