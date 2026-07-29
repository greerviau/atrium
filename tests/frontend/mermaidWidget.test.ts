import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { MermaidWidget } from "../../src/lib/editor/markdown/widgets";
import { clearMermaidRenderCache, loadMermaid } from "../../src/lib/editor/markdown/mermaid";

// Only `loadMermaid` is stubbed (it would pull in Mermaid's real bundle); the
// render cache and theme-variable reading are the genuine implementations, so
// the caching behavior below is exercised rather than mocked away.
vi.mock("../../src/lib/editor/markdown/mermaid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/editor/markdown/mermaid")>()),
  loadMermaid: vi.fn(),
}));

function mockMermaidModule(render: (id: string, source: string) => Promise<{ svg: string }>) {
  vi.mocked(loadMermaid).mockResolvedValue({
    default: { render, initialize: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof loadMermaid>>);
}

function makeView(doc = "```mermaid\ngraph TD;\nA-->B;\n```\n"): EditorView {
  return new EditorView({ state: EditorState.create({ doc }), parent: document.createElement("div") });
}

describe("MermaidWidget", () => {
  beforeEach(() => {
    vi.mocked(loadMermaid).mockReset();
    clearMermaidRenderCache();
    document.documentElement.style.removeProperty("--atrium-code-bg");
  });

  it("injects the returned svg markup on a successful render", async () => {
    mockMermaidModule(() => Promise.resolve({ svg: "<svg>diagram</svg>" }));

    const widget = new MermaidWidget("graph TD;\nA-->B;", 0);
    const view = makeView();
    const dom = widget.toDOM(view);

    await vi.waitFor(() => expect(dom.innerHTML).toContain("<svg>diagram</svg>"));
    expect(dom.classList.contains("cm-mermaid-error")).toBe(false);
    view.destroy();
  });

  it("shows an error panel with the parser's message on a rejected render, and is click-to-edit", async () => {
    mockMermaidModule(() => Promise.reject(new Error("Parse error on line 2")));

    const widget = new MermaidWidget("bad syntax here", 5);
    const view = makeView();
    const dom = widget.toDOM(view);

    await vi.waitFor(() => expect(dom.classList.contains("cm-mermaid-error")).toBe(true));
    expect(dom.textContent).toContain("Invalid Mermaid diagram");
    expect(dom.textContent).toContain("Parse error on line 2");

    dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.selection.main.from).toBe(5);
    expect(view.state.selection.main.to).toBe(5);

    view.destroy();
  });

  // CodeMirror rebuilds the whole content when a scroll lands outside the
  // drawn range, and `eq()` cannot prevent a re-created widget from calling
  // `toDOM` again. Rendering asynchronously there leaves the container empty
  // for a frame, moving the height map by the diagram's full height and
  // shifting the content below it — the backward scrolling of issue #311. So a
  // diagram already rendered once must come back *synchronously*.
  it("replays an already-rendered diagram synchronously, without re-rendering", async () => {
    const render = vi.fn(() => Promise.resolve({ svg: "<svg>diagram</svg>" }));
    mockMermaidModule(render);

    const view = makeView();
    const first = new MermaidWidget("graph TD;\nA-->B;", 0);
    const firstDom = first.toDOM(view);
    await vi.waitFor(() => expect(firstDom.innerHTML).toContain("<svg>diagram</svg>"));
    expect(render).toHaveBeenCalledTimes(1);

    // A distinct instance, as a rebuild produces — not the same object reused.
    const rebuilt = new MermaidWidget("graph TD;\nA-->B;", 0);
    const rebuiltDom = rebuilt.toDOM(view);

    // No `waitFor`: the markup must be present on return, before any await.
    expect(rebuiltDom.innerHTML).toContain("<svg>diagram</svg>");
    expect(render).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("re-renders rather than replaying a cached diagram when the theme changes", async () => {
    const render = vi
      .fn()
      .mockResolvedValueOnce({ svg: "<svg>dark</svg>" })
      .mockResolvedValueOnce({ svg: "<svg>light</svg>" });
    mockMermaidModule(render as unknown as (id: string, source: string) => Promise<{ svg: string }>);

    const view = makeView();
    const dark = new MermaidWidget("graph TD;\nA-->B;", 0).toDOM(view);
    await vi.waitFor(() => expect(dark.innerHTML).toContain("<svg>dark</svg>"));

    // `atriumMermaidThemeVariables()` reads these custom properties fresh on
    // every render, so changing one is what a theme switch looks like here.
    document.documentElement.style.setProperty("--atrium-code-bg", "#ffffff");

    const light = new MermaidWidget("graph TD;\nA-->B;", 0).toDOM(view);
    expect(light.innerHTML).not.toContain("<svg>dark</svg>");
    await vi.waitFor(() => expect(light.innerHTML).toContain("<svg>light</svg>"));
    expect(render).toHaveBeenCalledTimes(2);
    view.destroy();
  });

  it("eq() compares by source text only, ignoring position", () => {
    const a = new MermaidWidget("graph TD;\nA-->B;", 0);
    const b = new MermaidWidget("graph TD;\nA-->B;", 40);
    const c = new MermaidWidget("graph TD;\nA-->C;", 0);

    expect(a.eq(b)).toBe(true);
    expect(a.eq(c)).toBe(false);
  });

  it("does not mutate the DOM after destroy(), even if the render resolves late", async () => {
    let resolveRender: (value: { svg: string }) => void = () => {};
    mockMermaidModule(
      () =>
        new Promise((resolve) => {
          resolveRender = resolve;
        }),
    );

    const widget = new MermaidWidget("graph TD;\nA-->B;", 0);
    const view = makeView();
    const dom = widget.toDOM(view);

    // Widget is torn down (e.g. scrolled out of view) before the async
    // render call resolves.
    widget.destroy();
    resolveRender({ svg: "<svg>late</svg>" });

    // Flush the microtask queue the resolved promise's `.then` runs on.
    await Promise.resolve();
    await Promise.resolve();

    expect(dom.innerHTML).toBe("");
    view.destroy();
  });

  it("renders normally on a toDOM() call that follows a destroy() on the same instance (scroll away then back)", async () => {
    mockMermaidModule(() => Promise.resolve({ svg: "<svg>diagram</svg>" }));

    const widget = new MermaidWidget("graph TD;\nA-->B;", 0);
    const view = makeView();

    const firstDom = widget.toDOM(view);
    await vi.waitFor(() => expect(firstDom.innerHTML).toContain("<svg>diagram</svg>"));

    // Block scrolls fully out of the drawn viewport; CodeMirror tears down
    // the tile.
    widget.destroy();

    // Block scrolls back into view; CodeMirror reuses the same widget
    // instance and calls toDOM() again.
    const secondDom = widget.toDOM(view);
    await vi.waitFor(() => expect(secondDom.innerHTML).toContain("<svg>diagram</svg>"));

    view.destroy();
  });

  it("shows the error panel on a toDOM() call that follows a destroy() on the same instance, for invalid syntax", async () => {
    mockMermaidModule(() => Promise.reject(new Error("Parse error on line 2")));

    const widget = new MermaidWidget("bad syntax here", 5);
    const view = makeView();

    const firstDom = widget.toDOM(view);
    await vi.waitFor(() => expect(firstDom.classList.contains("cm-mermaid-error")).toBe(true));

    widget.destroy();

    const secondDom = widget.toDOM(view);
    await vi.waitFor(() => expect(secondDom.classList.contains("cm-mermaid-error")).toBe(true));
    expect(secondDom.textContent).toContain("Invalid Mermaid diagram");
    expect(secondDom.textContent).toContain("Parse error on line 2");

    view.destroy();
  });
});
