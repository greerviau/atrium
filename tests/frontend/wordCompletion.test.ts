import { describe, it, expect, afterEach } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { autocompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { documentWordCompletion } from "../../src/lib/editor/wordCompletion";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mount(doc: string, cursor: number, extensions: Extension[] = []): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [documentWordCompletion, autocompletion(), ...extensions],
    }),
  });
}

function type(view: EditorView, text: string): void {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.type",
  });
}

function backspace(view: EditorView): void {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos - 1, to: pos, insert: "" },
    selection: { anchor: pos - 1 },
    userEvent: "delete.backward",
  });
}

async function waitForSettledCompletions(view: EditorView): Promise<readonly { label: string }[]> {
  // activateOnTypingDelay (100ms) plus a comfortable margin, matching the
  // interactionDelay margin used for the Tab-accept tests elsewhere in this
  // change (see EditorPane.completion.test.ts) rather than the tighter
  // number that proved flaky there.
  await sleep(300);
  return currentCompletions(view.state);
}

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("document-word completion fallback", () => {
  it("offers a matching word in a JSON document, which has no completion source of its own", async () => {
    const doc = '{\n  "alphaKey": 1\n}\nalp';
    view = mount(doc, doc.length, [json()]);
    startCompletion(view);

    const completions = await waitForSettledCompletions(view);

    expect(completions.map((c) => c.label)).toContain("alphaKey");
  });

  it("dedupes with the language pack's own entry instead of doubling the row", async () => {
    const doc = "def mmap_read():\n    pass\n\nmm";
    view = mount(doc, doc.length, [python()]);
    startCompletion(view);

    const completions = await waitForSettledCompletions(view);
    const matches = completions.filter((c) => c.label === "mmap_read");

    expect(matches).toHaveLength(1);
    expect((matches[0] as { type?: string }).type).toBe("function");
  });

  it("offers neither a bare numeral nor a longer numeral at any prefix", async () => {
    const doc = "const values = [42, 4242];\n42";
    view = mount(doc, doc.length);
    startCompletion(view);

    const completions = await waitForSettledCompletions(view);

    expect(completions.map((c) => c.label)).not.toContain("42");
    expect(completions.map((c) => c.label)).not.toContain("4242");
  });

  it("offers nothing for a one-character implicit prefix, but reaches a one-character identifier on explicit invocation", async () => {
    view = mount("let i = 1;\n", 11);
    type(view, "i");

    const implicitCompletions = await waitForSettledCompletions(view);
    expect(implicitCompletions).toHaveLength(0);

    startCompletion(view);
    const explicitCompletions = await waitForSettledCompletions(view);
    expect(explicitCompletions.map((c) => c.label)).toContain("i");
  });

  it("closes rather than persists when the user backspaces from two characters to one", async () => {
    const doc = "let identifierWord = 1;\n";
    view = mount(doc, doc.length);
    type(view, "id");

    const opened = await waitForSettledCompletions(view);
    expect(opened.map((c) => c.label)).toContain("identifierWord");

    backspace(view);
    const afterBackspace = await waitForSettledCompletions(view);
    expect(afterBackspace).toHaveLength(0);
  });

  it("offers a name defined only inside another scope at top level (today: [])", async () => {
    const doc = "class Reader:\n    def helper_method(self):\n        pass\n\nhelper_";
    view = mount(doc, doc.length, [python()]);
    startCompletion(view);

    const completions = await waitForSettledCompletions(view);

    expect(completions.map((c) => c.label)).toContain("helper_method");
  });
});
