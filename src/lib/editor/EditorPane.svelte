<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorState } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import {
    tabsState,
    saveRequest,
    saveTab,
    markDirty,
    clearPendingSelection,
  } from "../stores/tabs";
  import { baseExtensions } from "./baseExtensions";
  import { markdownExtensions } from "./markdown/livePreviewPlugin";
  import { codeExtensions } from "./codeExtensions";

  let { filePath }: { filePath: string } = $props();

  let container: HTMLDivElement;
  let view: EditorView;

  const tab = $derived($tabsState.tabs.find((t) => t.path === filePath));

  function currentDoc(): string {
    return view.state.doc.toString();
  }

  async function save(): Promise<void> {
    await saveTab(filePath, currentDoc());
  }

  onMount(() => {
    const initialTab = $tabsState.tabs.find((t) => t.path === filePath);
    const mode = initialTab?.mode ?? "code";

    const extensions = [
      baseExtensions(),
      mode === "markdown" ? markdownExtensions(filePath) : [lineNumbers(), ...codeExtensions(filePath)],
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            void save();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          markDirty(filePath);
        }
      }),
    ];

    view = new EditorView({
      state: EditorState.create({
        doc: initialTab?.savedDoc ?? "",
        extensions,
      }),
      parent: container,
    });
  });

  onDestroy(() => {
    view?.destroy();
  });

  // External-change reconciliation (section 6.2): when the tab is clean and
  // its `savedDoc` changes underneath us (silent reload after `fs:changed`,
  // or the "Reload" conflict-banner action), replace the CM6 doc to match.
  $effect(() => {
    const current = tab;
    if (!view || !current || current.isDirty) {
      return;
    }
    if (current.savedDoc !== currentDoc()) {
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: current.savedDoc },
      });
      const newLineCount = view.state.doc.lines;
      const targetLine = Math.min(cursorLine, newLineCount);
      const linePos = view.state.doc.line(targetLine).from;
      view.dispatch({ selection: { anchor: linePos } });
    }
  });

  // Scrolls to a pending selection (from a markdown/terminal/explorer "open
  // to line" request) once the view exists, then clears it.
  $effect(() => {
    const current = tab;
    if (!view || !current?.pendingSelection) {
      return;
    }
    const { line, col } = current.pendingSelection;
    const doc = view.state.doc;
    if (line >= 1 && line <= doc.lines) {
      const lineInfo = doc.line(line);
      const pos = col ? Math.min(lineInfo.from + col - 1, lineInfo.to) : lineInfo.from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      view.focus();
    }
    clearPendingSelection(filePath);
  });

  $effect(() => {
    if ($saveRequest === filePath) {
      void save().then(() => saveRequest.set(null));
    }
  });
</script>

<div class="editor-pane" bind:this={container}></div>

<style>
  .editor-pane {
    height: 100%;
    overflow: auto;
  }

  .editor-pane :global(.cm-editor) {
    height: 100%;
  }
</style>
