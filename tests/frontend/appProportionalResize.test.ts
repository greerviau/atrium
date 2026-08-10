import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import {
  explorerVisible,
  terminalVisible,
  terminalPosition,
  setTerminalPosition,
  saveExplorerWidth,
  saveTerminalLayout,
  EXPLORER_WIDTH_MIN,
} from "../../src/lib/stores/layout";

vi.mock("../../src/lib/explorer/FileTree.svelte", async () => {
  const mod = await import("./FileTreeStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    workspaceTakePendingOpen: vi.fn().mockResolvedValue([]),
    appConfirmClose: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  explorerVisible.set(true);
  terminalVisible.set(true);
  terminalPosition.set("bottom");
}

function pointerLikeEvent(type: string, delta: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "clientX", { value: delta, configurable: true });
  Object.defineProperty(event, "clientY", { value: delta, configurable: true });
  return event;
}

/** Simulates a full pointerdown/pointermove/pointerup drag of the explorer resizer, moving it by `delta` pixels from its current width. */
function dragExplorer(container: HTMLElement, delta: number): void {
  const resizer = container.querySelector(".explorer + .resizer")!;
  resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
  window.dispatchEvent(pointerLikeEvent("pointermove", delta));
  window.dispatchEvent(new Event("pointerup"));
}

/** Same as `dragExplorer`, for the editor/terminal resizer. Works for any dock position: `startDragTerminal` reads whichever of clientX/clientY applies. */
function dragTerminal(container: HTMLElement, delta: number): void {
  const resizer = container.querySelector(".main .resizer")!;
  resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
  window.dispatchEvent(pointerLikeEvent("pointermove", delta));
  window.dispatchEvent(new Event("pointerup"));
}

function setAppWidth(container: HTMLElement, width: number): void {
  const app = container.querySelector(".app") as HTMLElement;
  Object.defineProperty(app, "clientWidth", { value: width, configurable: true });
}

function setMainSize(container: HTMLElement, size: { width?: number; height?: number }): void {
  const main = container.querySelector(".main") as HTMLElement;
  if (size.width !== undefined) Object.defineProperty(main, "clientWidth", { value: size.width, configurable: true });
  if (size.height !== undefined) Object.defineProperty(main, "clientHeight", { value: size.height, configurable: true });
}

function explorerStyleWidth(container: HTMLElement): number {
  const el = container.querySelector(".explorer") as HTMLElement;
  return Number(el.style.width.replace("px", ""));
}

function terminalStyle(container: HTMLElement): { width: string; height: string } {
  const el = container.querySelector(".terminal-area") as HTMLElement;
  return { width: el.style.width, height: el.style.height };
}

async function fireResize(): Promise<void> {
  window.dispatchEvent(new Event("resize"));
  await tick();
  await tick();
}

function renderApp() {
  workspace.set({ id: "local", root: "/projects/demo" });
  return render(App);
}

/**
 * Stubs `clientWidth`/`clientHeight` on `HTMLElement.prototype` for the
 * duration of `fn`, so a component's *first* container-availability pass
 * (its mount-time effects, not just a later resize) sees a real, nonzero
 * container size — jsdom itself always reports 0, which is why the cold
 * start path needs this rather than the post-render `Object.defineProperty`
 * on a single queried element used elsewhere in this file.
 */
async function withStubbedContainerSize(width: number, height: number, fn: () => Promise<void>): Promise<void> {
  // `clientWidth`/`clientHeight` are owned by `Element.prototype`, not
  // `HTMLElement.prototype` — so `getOwnPropertyDescriptor(HTMLElement...)`
  // is undefined here, and stubbing on `HTMLElement.prototype` adds a new
  // *own* property that shadows the inherited one, rather than overwriting
  // an existing own one. Restoring must therefore `delete` that added own
  // property when there was no prior own descriptor, not skip restoring —
  // skipping would leave the stub permanently shadowing every element
  // created for the rest of the test run.
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
  try {
    await fn();
  } finally {
    if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDescriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDescriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  }
}

describe("App proportional panel resize (#301)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("preserves the explorer's dragged proportion when the window shrinks (basic case)", async () => {
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 2000);
    dragExplorer(container, 500 - 240);
    await tick();
    expect(explorerStyleWidth(container)).toBe(500);

    setAppWidth(container, 1000);
    await fireResize();

    expect(explorerStyleWidth(container)).toBe(250);
  });

  it("clamp-and-recover: explorer recovers its exact pre-clamp width, proving a stable ratio rather than frame-to-frame rescaling", async () => {
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 2000);
    dragExplorer(container, 500 - 240);
    await tick();
    expect(explorerStyleWidth(container)).toBe(500);

    setAppWidth(container, 500);
    await fireResize();
    // round(0.25 * 500) = 125, below EXPLORER_WIDTH_MIN (140) -> clamps.
    expect(explorerStyleWidth(container)).toBe(EXPLORER_WIDTH_MIN);

    setAppWidth(container, 2000);
    await fireResize();
    // Stable-ratio design: round(0.25 * 2000) = 500, exactly recovered.
    // A rescale-from-previous-frame design would instead compute
    // round(140 * (2000 / 500)) = 560 here.
    expect(explorerStyleWidth(container)).toBe(500);
    expect(explorerStyleWidth(container)).not.toBe(560);
  });

  it("clamp-and-recover: terminal (docked left) recovers its exact pre-clamp width the same way", async () => {
    terminalPosition.set("left");
    explorerVisible.set(false);
    saveTerminalLayout({ position: "left", height: 240, width: 300 });
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000 });
    dragTerminal(container, 0); // establishes terminalWidthRatio = 300 / 1000 = 0.3
    await tick();
    expect(terminalStyle(container).width).toBe("300px");

    setAppWidth(container, 350);
    await fireResize();
    // round(0.3 * 350) = 105, below WIDTH_MIN (140) -> clamps.
    expect(terminalStyle(container).width).toBe("140px");

    setAppWidth(container, 1000);
    await fireResize();
    // Exact recovery, not round(140 * (1000/350)) = 400.
    expect(terminalStyle(container).width).toBe("300px");
    expect(terminalStyle(container).width).not.toBe("400px");
  });

  it("MF1 regression: derives the terminal's containerWidth analytically instead of reading a stale mainEl.clientWidth in the same pass as the explorer's write", async () => {
    terminalPosition.set("left");
    saveExplorerWidth(240);
    saveTerminalLayout({ position: "left", height: 240, width: 300 });
    const { container } = renderApp();
    await tick();
    await tick();

    // Establish explorerRatio = 0.25 at appEl.clientWidth = 1000 (drag to 250).
    setAppWidth(container, 1000);
    dragExplorer(container, 250 - 240);
    await tick();
    expect(explorerStyleWidth(container)).toBe(250);

    // Establish terminalWidthRatio = 0.3 at a clean mainEl.clientWidth = 1000
    // (a drag-end establishment just needs some container-width snapshot at
    // that moment, independent of whatever produced it).
    setMainSize(container, { width: 1000 });
    dragTerminal(container, 0);
    await tick();
    expect(terminalStyle(container).width).toBe("300px");

    // The single resize: appEl 1000 -> 2500 (the worked example from the
    // review that caught MF1). Deliberately leave mainEl.clientWidth at the
    // *stale* value a pre-repaint read would have produced (old sidebar
    // width 250 against the *new* 2500 window: 2500 - 250 - 4 = 2246) so
    // that a regression back to reading mainEl.clientWidth here would be
    // caught: it would compute the terminal's ratio against 2246 instead of
    // the correct analytic 1896, landing on 674 instead of 569.
    setAppWidth(container, 2500);
    setMainSize(container, { width: 2246 });
    await fireResize();

    expect(explorerStyleWidth(container)).toBe(600);
    expect(terminalStyle(container).width).toBe("569px");
    expect(terminalStyle(container).width).not.toBe("674px");
  });

  it("floor clamp on extreme shrink: never below the explorer's own minimum, never zero", async () => {
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 2000);
    dragExplorer(container, 500 - 240);
    await tick();

    setAppWidth(container, 50);
    await fireResize();

    expect(explorerStyleWidth(container)).toBe(EXPLORER_WIDTH_MIN);
  });

  it("cold start clamps a persisted terminal width wider than the container (dock left), so the editor never collapses to 0px", async () => {
    terminalPosition.set("left");
    explorerVisible.set(false);
    saveTerminalLayout({ position: "left", height: 240, width: 1200 });

    await withStubbedContainerSize(1000, 1000, async () => {
      const { container } = renderApp();
      await tick();
      await tick();

      // clampToContainer(1200, WIDTH_MIN, 1000, 204) = 796: the terminal's
      // very first sync (establishing its ratio, not a later resize) must
      // clamp the persisted value against the container it just became
      // available in, or an oversized saved width renders past its
      // container and squeezes the editor to 0.
      expect(terminalStyle(container).width).toBe("796px");
    });
  });

  it("cold start clamps a persisted terminal height taller than the container (dock bottom)", async () => {
    terminalPosition.set("bottom");
    saveTerminalLayout({ position: "bottom", height: 900, width: 320 });

    await withStubbedContainerSize(1000, 1000, async () => {
      const { container } = renderApp();
      await tick();
      await tick();

      expect(terminalStyle(container).height).toBe("796px");
    });
  });

  it("cold start clamps the INACTIVE dimension too: a bottom-docked start with an oversized persisted width, then a dock switch, never renders the unclamped raw width", async () => {
    terminalPosition.set("bottom");
    explorerVisible.set(false);
    // width (1200) is inactive while docked "bottom" — never dragged, never
    // touched by a resize, so it holds whatever was last persisted.
    saveTerminalLayout({ position: "bottom", height: 300, width: 1200 });

    await withStubbedContainerSize(1000, 1000, async () => {
      const { container } = renderApp();
      await tick();
      await tick();

      // Switching the dock (as the settings dialog does) makes width the
      // active dimension. Nothing re-renders from a resize here — this only
      // passes if width was already clamped against the container back at
      // cold start, alongside height, even though it wasn't the active
      // dimension at the time.
      setTerminalPosition("left");
      await tick();
      await tick();

      expect(terminalStyle(container).width).toBe("796px");
    });
  });

  it("a resize while the explorer is hidden doesn't show it or leave a gap", async () => {
    explorerVisible.set(false);
    const { container } = renderApp();
    await tick();
    await tick();

    expect(container.querySelector(".explorer")).toBeNull();

    setAppWidth(container, 1200);
    await fireResize();

    expect(container.querySelector(".explorer")).toBeNull();
  });

  it("a resize while the explorer is hidden is remembered for when it's shown again", async () => {
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 2000);
    dragExplorer(container, 500 - 240);
    await tick();
    expect(explorerStyleWidth(container)).toBe(500);

    explorerVisible.set(false);
    await tick();
    expect(container.querySelector(".explorer")).toBeNull();

    setAppWidth(container, 1000);
    await fireResize();

    explorerVisible.set(true);
    await tick();
    await tick();

    // 25% of the *current* 1000px container, not the stale pre-hide 500px.
    expect(explorerStyleWidth(container)).toBe(250);
  });

  it.each([
    ["bottom" as const, 300, 1000, 500],
    ["left" as const, 400, 1000, 500],
    ["right" as const, 400, 1000, 500],
  ])(
    "terminal dock docked %s: basic shrink preserves the dragged proportion",
    async (position, initialPx, establishSize, shrinkSize) => {
      terminalPosition.set(position);
      explorerVisible.set(false);
      const layout =
        position === "bottom"
          ? { position, height: initialPx, width: 320 }
          : { position, height: 240, width: initialPx };
      saveTerminalLayout(layout);
      const { container } = renderApp();
      await tick();
      await tick();

      setAppWidth(container, establishSize);
      setMainSize(container, { width: establishSize, height: establishSize });
      dragTerminal(container, 0); // establishes the active ratio at initialPx / establishSize
      await tick();

      if (position === "bottom") {
        setMainSize(container, { height: shrinkSize });
      } else {
        setAppWidth(container, shrinkSize);
      }
      await fireResize();

      const expected = Math.round((initialPx / establishSize) * shrinkSize);
      const style = terminalStyle(container);
      expect(position === "bottom" ? style.height : style.width).toBe(`${expected}px`);
    },
  );

  it("switching dock position lazily establishes the newly-active dimension's ratio instead of throwing or staying stuck", async () => {
    explorerVisible.set(false);
    terminalPosition.set("bottom");
    saveTerminalLayout({ position: "bottom", height: 300, width: 400 });
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000, height: 1000 });
    dragTerminal(container, 0); // establishes terminalHeightRatio = 300/1000 = 0.3 only
    await tick();

    setTerminalPosition("left");
    await tick();

    // First resize since the switch: terminalWidthRatio was never
    // established for "left" before now, so this call only establishes it
    // (from the persisted width, 400, against the container at this
    // moment) — the pixel value stays at its last-known 400, unmodified.
    setAppWidth(container, 800);
    await fireResize();
    expect(terminalStyle(container).width).toBe("400px");

    // Second resize: the now-established ratio (400/800 = 0.5) actually
    // rescales.
    setAppWidth(container, 600);
    await fireResize();
    expect(terminalStyle(container).width).toBe("300px");
  });

  it("a manual drag re-baselines the ratio for subsequent resizes", async () => {
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 2000);
    dragExplorer(container, 300 - 240); // first drag: width 300, ratio 0.15
    await tick();

    dragExplorer(container, 60); // second drag from 300 -> 360, ratio 0.18
    await tick();
    expect(explorerStyleWidth(container)).toBe(360);

    setAppWidth(container, 1000);
    await fireResize();

    // Uses the *new* post-drag ratio (0.18 -> 180), not the pre-redrag one
    // (0.15 -> 150).
    expect(explorerStyleWidth(container)).toBe(180);
    expect(explorerStyleWidth(container)).not.toBe(150);
  });

  it("firing several resize events with no drag in between never writes to localStorage (explorer)", async () => {
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 2000);
    dragExplorer(container, 500 - 240);
    await tick();

    const afterDrag = localStorage.getItem("atrium.layout.explorer");
    expect(afterDrag).toBe(JSON.stringify(500));

    setAppWidth(container, 1000);
    await fireResize();
    setAppWidth(container, 1600);
    await fireResize();
    setAppWidth(container, 300);
    await fireResize();

    expect(localStorage.getItem("atrium.layout.explorer")).toBe(afterDrag);
  });

  it("firing several resize events with no drag in between never writes to localStorage (terminal)", async () => {
    terminalPosition.set("left");
    explorerVisible.set(false);
    saveTerminalLayout({ position: "left", height: 240, width: 300 });
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000 });
    dragTerminal(container, 0);
    await tick();

    const afterDrag = localStorage.getItem("atrium.layout.terminal");
    expect(JSON.parse(afterDrag ?? "")).toEqual({ position: "left", height: 240, width: 300 });

    setAppWidth(container, 500);
    await fireResize();
    setAppWidth(container, 2000);
    await fireResize();

    expect(localStorage.getItem("atrium.layout.terminal")).toBe(afterDrag);
  });

  it("dragging the explorer sidebar alone does not rescale the terminal panel", async () => {
    terminalPosition.set("left");
    saveTerminalLayout({ position: "left", height: 240, width: 300 });
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000 });
    dragTerminal(container, 0); // establishes the terminal's own ratio first
    await tick();
    expect(terminalStyle(container).width).toBe("300px");

    // Dragging the explorer wider changes mainEl's width as a side effect in
    // a real browser, but fires no `resize` event.
    dragExplorer(container, 100);
    await tick();

    expect(terminalStyle(container).width).toBe("300px");
  });

  it("toggling the explorer sidebar redistributes the terminal's width by ratio, not just to the editor (issue #402)", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200 (ratio 0.2 @ appWidth 1000)
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 398 - 320); // terminalWidth -> 398 (ratio 0.5 @ mainContentWidth 796)
    await tick();
    expect(terminalStyle(container).width).toBe("398px");

    explorerVisible.set(false);
    await tick();
    await tick();

    expect(container.querySelector(".explorer")).toBeNull();
    // The freed 204px (explorer + resizer) is redistributed by ratio: the
    // terminal grows to 50% of the now-full 1000px main content width,
    // instead of staying pinned at its stale 398px.
    expect(terminalStyle(container).width).toBe("500px");

    explorerVisible.set(true);
    await tick();
    await tick();

    // Restoring the sidebar gives the ratio back exactly.
    expect(terminalStyle(container).width).toBe("398px");
  });

  it("re-baselines the terminal's ratio on an explorer drag, so a later toggle round-trips exactly (issue #402)", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 398 - 320); // terminalWidth -> 398 (ratio 0.5 @ 796)
    await tick();

    // A further explorer drag alone must not rescale the terminal's pixels
    // (the existing contract pinned above), but it must re-baseline the
    // terminal's ratio to its new on-screen fraction of `.main`.
    dragExplorer(container, 300 - 200); // explorerWidth -> 300
    await tick();
    expect(terminalStyle(container).width).toBe("398px");

    explorerVisible.set(false);
    await tick();
    await tick();

    // 398 / (1000 - 300 - 4) = 398/696, the terminal's actual on-screen
    // fraction right before the toggle, applied to the now-full 1000px main
    // content width -> round(398/696 * 1000) = 572. A stale pre-drag ratio
    // (398/796 = 0.5) would instead give 500.
    expect(terminalStyle(container).width).toBe("572px");

    explorerVisible.set(true);
    await tick();
    await tick();

    // Exact round-trip: round(398/696 * 696) = 398.
    expect(terminalStyle(container).width).toBe("398px");
  });

  it("bottom-docked terminal is unaffected by the explorer sidebar toggle (issue #402)", async () => {
    terminalPosition.set("bottom");
    saveTerminalLayout({ position: "bottom", height: 400, width: 320 });
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000, height: 1000 });
    dragTerminal(container, 0); // establishes terminalHeightRatio = 400/1000
    await tick();
    expect(terminalStyle(container).height).toBe("400px");

    explorerVisible.set(false);
    await tick();
    await tick();

    // A sidebar toggle never changes `.main`'s height, so the bottom-docked
    // terminal's height is unaffected, and its width is never set at all —
    // `.terminal-area`'s inline style only sets `width` when docked
    // left/right.
    expect(terminalStyle(container).height).toBe("400px");
    expect(terminalStyle(container).width).toBe("");

    explorerVisible.set(true);
    await tick();
    await tick();

    expect(terminalStyle(container).height).toBe("400px");
    expect(terminalStyle(container).width).toBe("");
  });
});
