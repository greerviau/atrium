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
import { endDragLock } from "../../src/lib/ui/dragLock";

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

/**
 * Simulates a full pointerdown/pointermove/`terminator` drag of the explorer
 * resizer, moving it by `delta` pixels from its current width. `terminator`
 * defaults to `"pointerup"`; the drag-lock coverage below also needs
 * `"pointercancel"` and `"blur"` as terminators of the same gesture.
 */
function dragExplorer(container: HTMLElement, delta: number, terminator = "pointerup"): void {
  const resizer = container.querySelector(".explorer + .resizer")!;
  resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
  window.dispatchEvent(pointerLikeEvent("pointermove", delta));
  window.dispatchEvent(new Event(terminator));
}

/** Same as `dragExplorer`, for the editor/terminal resizer. Works for any dock position: `startDragTerminal` reads whichever of clientX/clientY applies. */
function dragTerminal(container: HTMLElement, delta: number, terminator = "pointerup"): void {
  const resizer = container.querySelector(".main .resizer")!;
  resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
  window.dispatchEvent(pointerLikeEvent("pointermove", delta));
  window.dispatchEvent(new Event(terminator));
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
    endDragLock();
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

    // Establish terminalWidthRatio = 0.3 at a clean .main content width of
    // 1000 (a drag-end establishment just needs some container-width
    // snapshot at that moment, independent of whatever produced it) —
    // appEl.clientWidth 1254 minus the explorer's already-committed 250 and
    // the resizer's 4px. Issue #427 routed this establishment through the
    // analytic mainContentWidth too (it used to read mainEl.clientWidth
    // directly, correct only because this handler never writes explorerWidth
    // in the same pass, not by construction — see the "seven sites, three
    // sources" note in rebaselineTerminalWidth's dock-switch-era callers),
    // so the snapshot is set on appEl now rather than on mainEl directly.
    setAppWidth(container, 1254);
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

  it("switching dock position re-baselines the newly-active dimension from what is on screen", async () => {
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

    // The switch itself never resizes the panel — it only records
    // terminalWidthRatio = 400 / 1000 = 0.4 from what's already on screen.
    expect(terminalStyle(container).width).toBe("400px");

    // The ratio is already established, so the *first* resize after the
    // switch rescales, rather than silently establishing (issue #416).
    setAppWidth(container, 800);
    await fireResize();
    expect(terminalStyle(container).width).toBe("320px");

    setAppWidth(container, 600);
    await fireResize();
    expect(terminalStyle(container).width).toBe("240px");
  });

  it.each(["left" as const, "right" as const])(
    "switching the dock away and back (docked %s) re-baselines the ratio, so a later sidebar toggle round-trips exactly (#416 AC1)",
    async (position) => {
      terminalPosition.set(position);
      explorerVisible.set(true);
      saveTerminalLayout({ position, height: 240, width: 398 });
      const { container } = renderApp();
      await tick();
      await tick();

      setAppWidth(container, 1000);
      dragExplorer(container, 200 - 240); // explorerWidth -> 200
      await tick();

      setMainSize(container, { width: 796, height: 796 });
      dragTerminal(container, 0); // establishes terminalWidthRatio = 398 / 796 = 0.5
      await tick();
      expect(terminalStyle(container).width).toBe("398px");

      setTerminalPosition("bottom");
      await tick();
      dragExplorer(container, 300 - 200); // explorerWidth -> 300; width is frozen, guarded off
      await tick();
      setTerminalPosition(position);
      await tick();

      // The switch back never resizes the panel; it only re-baselines the
      // ratio against .main's content width at this moment (1000 - 300 - 4 =
      // 696): 398 / 696 = 0.5718.
      expect(terminalStyle(container).width).toBe("398px");

      explorerVisible.set(false);
      await tick();
      await tick();
      // round(398 / 696 * 1000) = 572. Without the fix (no dock-switch
      // re-baseline at all), the stale ratio from before the switch away
      // (0.5) would instead give 500.
      expect(terminalStyle(container).width).toBe("572px");

      explorerVisible.set(true);
      await tick();
      await tick();
      // Exact round trip: round(398 / 696 * 696) = 398. Without the fix this
      // sequence is 398 -> 500 -> 348 (the issue's own reported numbers).
      expect(terminalStyle(container).width).toBe("398px");
    },
  );

  it("a window resize while width is frozen goes stale until the dock switches back, which must correct it rather than apply it as-is (#416 AC2, corrected)", async () => {
    // Explorer hidden throughout, so nothing about the sidebar can be
    // mistaken for the cause — see the plan's "Reproductions" section for why
    // AC2's literal wording ("no other change") doesn't reproduce and this
    // sequence (a window resize while docked bottom) is the minimal one that
    // does.
    explorerVisible.set(false);
    terminalPosition.set("left");
    saveTerminalLayout({ position: "left", height: 240, width: 400 });
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000, height: 1000 });
    dragTerminal(container, 0); // establishes terminalWidthRatio = 400 / 1000 = 0.4
    await tick();

    setTerminalPosition("bottom"); // width is now frozen
    await tick();

    // The width branch is guarded off while docked bottom, so the panel
    // stays at 400 while its container becomes 1600 and the recorded 0.4
    // goes stale.
    setAppWidth(container, 1600);
    setMainSize(container, { width: 1600 });
    await fireResize();

    setTerminalPosition("left");
    await tick();
    // The switch re-baselines to 400 / 1600 = 0.25 and does not move the
    // panel.
    expect(terminalStyle(container).width).toBe("400px");

    // A resize that changes nothing.
    await fireResize();
    // With the fix, the freshly re-baselined 0.25 reproduces the same pixel
    // value against the same, unchanged container: still 400px, exactly as a
    // no-op resize should render. On `main` today the dock switch never
    // re-baselines anything, so the ratio is still the pre-freeze 0.4, and
    // applying it against the 1600px container it was never checked against
    // jumps the panel to 640px — with no user input and no size change at
    // all.
    expect(terminalStyle(container).width).toBe("400px");

    // Now a real resize: 1600 -> 1200.
    setAppWidth(container, 1200);
    setMainSize(container, { width: 1200 });
    await fireResize();
    // Fixed: round(0.25 * 1200) = 300, proportional to the container's own
    // real shrink. On `main` this instead gives round(0.4 * 1200) = 480 — not
    // because this step's own resize behaves oddly (it's a real,
    // proportional one), but because the ratio the dock switch handed back
    // was never corrected off its pre-freeze value in the first place, so
    // every apply from that point on measures the wrong fraction of whatever
    // container it's given.
    expect(terminalStyle(container).width).toBe("300px");
  });

  it("dragging the explorer past the terminal's container-relative maximum clamps it live, and hiding the sidebar afterward recovers the pre-squeeze preference (#417 AC1/AC2, #427)", async () => {
    // Issue #417's own reproduction reads "Expected: terminal width stays at
    // 592px throughout" — that still describes buggy behaviour, not this
    // fix's: the live clamp below squeezes the terminal to 192px the moment
    // it no longer fits, during the drag itself, so 592px is gone the
    // instant the sidebar passes that point, exactly as it was pre-#427.
    // What #427 changes is what happens next: hiding the sidebar is room
    // becoming available, so it now recovers the 592px the user actually
    // chose, rather than re-deriving a fraction of the squeezed 192px that
    // corresponds to nothing anyone asked for (issue #427).
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 592 - 320); // terminalWidth -> 592, its container-relative maximum
    await tick();
    expect(terminalStyle(container).width).toBe("592px");

    // .main's content width becomes 1000 - 600 - 4 = 396; 592 no longer fits
    // (max(140, 396 - 204) = 192).
    dragExplorer(container, 600 - 200);
    await tick();
    expect(terminalStyle(container).width).toBe("192px");

    explorerVisible.set(false);
    await tick();
    await tick();
    // Before #427: round(192 / 396 * 1000) = 485, a number corresponding to
    // nothing anyone chose. After #427: the panel renders as much of its
    // 592px preference as the now-unconstrained 1000px container allows —
    // clampTerminalWidth(592, 1000) = 592, the full preference.
    expect(terminalStyle(container).width).toBe("592px");

    explorerVisible.set(true);
    await tick();
    await tick();
    // Exact round trip back to the squeezed width: only its midpoint moved.
    expect(terminalStyle(container).width).toBe("192px");
  });

  it("the terminal clamp is taken from the preference, so an overshoot-and-return within one drag is non-destructive", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 592 - 320); // terminalWidth -> 592, and terminalWidthPreferred -> 592
    await tick();

    const resizer = container.querySelector(".explorer + .resizer")!;
    resizer.dispatchEvent(pointerLikeEvent("pointerdown", 200));

    // Drag to explorer 600 (delta 400 from a start of 200): the preference
    // (592) clamps to 192 against the shrunk .main content width (396), and
    // the editor keeps its reserved minimum instead of collapsing. Issue
    // #427 replaced the gesture-local `startTerminalWidth` this comment used
    // to name with `terminalWidthPreferred`, a cross-gesture generalization
    // of the same value — this drag doesn't touch the preference itself
    // (only the explorer's own drag-end and the terminal's own resizer do),
    // so the mechanism this test pins is otherwise unchanged.
    window.dispatchEvent(pointerLikeEvent("pointermove", 600));
    await tick();
    expect(terminalStyle(container).width).toBe("192px");

    // Back to explorer 200 within the same gesture: the clamp is always
    // taken from the preference (592), not the live, possibly-clamped
    // `terminalWidth`, so this restores 592 exactly rather than ratcheting
    // down and staying there. A "clamp the current value" implementation
    // would return 192 here instead.
    window.dispatchEvent(pointerLikeEvent("pointermove", 200));
    await tick();
    expect(terminalStyle(container).width).toBe("592px");

    window.dispatchEvent(new Event("pointerup"));
    await tick();
    expect(terminalStyle(container).width).toBe("592px");
  });

  it("a dock switch cannot record an out-of-range ratio either (#416 + #417), and that ratio is now #427's squeeze carrier", async () => {
    // The D6 scenario: fixing #416 (re-baseline on a dock switch) without
    // #417's clamp would reintroduce #417's unclamped-ratio bug at the new
    // site, since a dock switch is exactly a moment the pixel value can be
    // out of range for the container it's about to be measured against.
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 592 - 320); // terminalWidth -> 592, its container-relative maximum
    await tick();

    setTerminalPosition("bottom");
    await tick();
    // Guarded off while docked bottom: terminalWidth stays 592 while .main's
    // content width shrinks to 396 as the sidebar widens.
    dragExplorer(container, 600 - 200);
    await tick();

    setTerminalPosition("left");
    await tick();
    // clampTerminalWidth(592, 396) = 192 — the same clamp #417 needed, still
    // exercised at the dock-switch site instead of the explorer drag-end.
    // The ratio it records is 592 / 396 = 1.4949, taken from the preference
    // rather than from this clamped 192: an out-of-range ratio here is no
    // longer #417's bug, it is issue #427's carrier for the squeeze (see
    // rebaselineTerminalWidth's own doc comment), and it is what makes the
    // hide-the-sidebar step below recover 592 instead of a re-derived
    // fraction of 192.
    expect(terminalStyle(container).width).toBe("192px");

    explorerVisible.set(false);
    await tick();
    await tick();
    // Before #427: round(192 / 396 * 1000) = 485. After: the panel recovers
    // as much of its 592px preference as the now-unconstrained 1000px
    // container allows, which is the full 592.
    expect(terminalStyle(container).width).toBe("592px");

    explorerVisible.set(true);
    await tick();
    await tick();
    expect(terminalStyle(container).width).toBe("192px");
  });

  it("an explorer drag that clamps the terminal moves it live but never persists it (#417 + D7): only the explorer's own drag writes localStorage", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 592 - 320); // terminalWidth -> 592, committed via the terminal's own resizer
    await tick();

    const terminalLayoutBeforeExplorerDrag = localStorage.getItem("atrium.layout.terminal");
    expect(JSON.parse(terminalLayoutBeforeExplorerDrag ?? "")).toEqual({ position: "left", height: 240, width: 592 });

    // Widen the sidebar past the point where the terminal no longer fits —
    // this clamps the terminal's live width from 592 to 192 (see the #417
    // tests above), a container-driven accommodation, not a choice made with
    // the terminal's own resizer.
    dragExplorer(container, 600 - 200);
    await tick();
    expect(terminalStyle(container).width).toBe("192px");

    // The explorer's own width is a choice made with the explorer's own
    // resizer, so it writes.
    expect(JSON.parse(localStorage.getItem("atrium.layout.explorer") ?? "")).toBe(600);
    // The terminal's clamp is not a choice — it writes nothing. The stored
    // width is still 592, the value the user last chose with the terminal's
    // own resizer, byte-identical to what was there before the explorer
    // drag.
    expect(localStorage.getItem("atrium.layout.terminal")).toBe(terminalLayoutBeforeExplorerDrag);
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

  // Narrowed, not removed, by the #417 fix: an explorer drag never rescales
  // the terminal proportionally — it only shrinks it when the terminal would
  // otherwise no longer fit, and never below what does fit (see the #417
  // tests above). This test's own numbers never reach that point (the
  // terminal's clamp here is `clamp(300, 140, 656) = 300`, a no-op), so every
  // assertion below is unchanged; only this comment is narrowed.
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

describe("App terminal preferred width (#427)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
    endDragLock();
  });

  /**
   * Establishes the geometry worked through in the plan: app 1000, sidebar
   * dragged to 200, `.main` content 796, terminal dragged to 400 with its
   * own resizer. Ratio at the end is 400 / 796 = 0.5025...
   */
  async function squeezeSetup(container: HTMLElement): Promise<void> {
    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 400 - 320); // terminalWidth -> 400
    await tick();
  }

  /** Widens the sidebar to its max (600), shrinking `.main` to 396 — below the terminal's preference, so it clamps to its floor of 192 (max(140, 396 - 204)). */
  async function squeeze(container: HTMLElement): Promise<void> {
    dragExplorer(container, 600 - 200); // explorerWidth -> 600
    await tick();
  }

  it("AC1: dragging the sidebar back after a squeeze restores the terminal to its pre-squeeze width", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    await squeezeSetup(container);
    expect(terminalStyle(container).width).toBe("400px");

    await squeeze(container);
    expect(terminalStyle(container).width).toBe("192px");

    dragExplorer(container, 200 - 600); // sidebar 600 -> 200
    await tick();
    expect(terminalStyle(container).width).toBe("400px");
  });

  it("AC1, bounded: a partial drag back only recovers as far as the new container allows", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    await squeezeSetup(container);
    await squeeze(container);
    expect(terminalStyle(container).width).toBe("192px");

    dragExplorer(container, 400 - 600); // sidebar 600 -> 400, .main content -> 596
    await tick();
    // clamp(400, 140, 596 - 204) = 392: a naive "restore the remembered
    // value unconditionally" would render 400 here and push the editor
    // below its reserved minimum.
    expect(terminalStyle(container).width).toBe("392px");

    dragExplorer(container, 200 - 400); // sidebar 400 -> 200, full recovery
    await tick();
    expect(terminalStyle(container).width).toBe("400px");
  });

  it("AC1 across a window resize: recovers as far as each container allows, and resumes proportional scaling once the squeeze fully lifts", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    await squeezeSetup(container);
    await squeeze(container);
    expect(terminalStyle(container).width).toBe("192px");

    // The sidebar is pinned at EXPLORER_WIDTH_MAX (600) throughout this
    // sequence, so the window's growth and shrinkage lands entirely in
    // `.main`. The recorded ratio (400 / 396, over 1) keeps taking the
    // squeeze branch at every one of these sizes.
    setAppWidth(container, 1200);
    await fireResize();
    expect(terminalStyle(container).width).toBe("392px");

    setAppWidth(container, 1400);
    await fireResize();
    expect(terminalStyle(container).width).toBe("400px");

    setAppWidth(container, 1000);
    await fireResize();
    expect(terminalStyle(container).width).toBe("192px");

    dragExplorer(container, 200 - 600); // sidebar 600 -> 200, squeeze lifts
    await tick();
    expect(terminalStyle(container).width).toBe("400px");

    // The squeeze is over and the drag-end re-baselined the ratio, so a
    // later resize scales proportionally again instead of staying pinned at
    // the preference — this is where §4 item 5's residual ends.
    setAppWidth(container, 1200);
    await fireResize();
    expect(terminalStyle(container).width).toBe("480px");
  });

  it("AC1 across a dock switch: the switch itself never resizes the squeezed panel, and the sidebar drag back still recovers it", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    await squeezeSetup(container);
    await squeeze(container);
    expect(terminalStyle(container).width).toBe("192px");

    setTerminalPosition("bottom");
    await tick();
    setTerminalPosition("left");
    await tick();
    expect(terminalStyle(container).width).toBe("192px");

    dragExplorer(container, 200 - 600); // sidebar 600 -> 200
    await tick();
    expect(terminalStyle(container).width).toBe("400px");
  });

  it("AC1 across a sidebar toggle: hiding and showing the sidebar round-trips exactly, and hiding it alone already recovers the preference", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    await squeezeSetup(container);
    await squeeze(container);
    expect(terminalStyle(container).width).toBe("192px");

    explorerVisible.set(false);
    await tick();
    await tick();
    // Hiding the sidebar is room becoming available, so the panel returns
    // to the width the user chose (400) rather than to a re-derived
    // fraction of the squeeze (issue #427's behaviour change).
    expect(terminalStyle(container).width).toBe("400px");

    explorerVisible.set(true);
    await tick();
    await tick();
    // Exact round trip: the toggle consumed nothing.
    expect(terminalStyle(container).width).toBe("192px");

    dragExplorer(container, 200 - 600); // sidebar 600 -> 200
    await tick();
    expect(terminalStyle(container).width).toBe("400px");
  });

  it("cold-start recovery: an oversized persisted width clamps at mount, then grows back as the sidebar narrows", async () => {
    terminalPosition.set("left");
    saveTerminalLayout({ position: "left", height: 240, width: 1200 });

    await withStubbedContainerSize(1000, 1000, async () => {
      const { container } = renderApp();
      await tick();
      await tick();

      // .main content at mount: 1000 - 240 (default explorer width) - 4 =
      // 756; clampTerminalWidth(1200, 756) = max(140, 756 - 204) = 552.
      expect(terminalStyle(container).width).toBe("552px");

      dragExplorer(container, EXPLORER_WIDTH_MIN - 240); // explorerWidth -> 140
      await tick();
      // .main content -> 1000 - 140 - 4 = 856; clamp(1200, 856) = 652: the
      // 1200 preference, seeded unclamped from the persisted width, grows
      // back toward its own value as room comes back, bounded by
      // clampTerminalWidth same as any other render.
      expect(terminalStyle(container).width).toBe("652px");
    });
  });

  it("a non-binding proportional rescale updates the preference too, not just the rendered width", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    await squeezeSetup(container); // terminalWidth -> 400 at content 796
    expect(terminalStyle(container).width).toBe("400px");

    setAppWidth(container, 1200);
    await fireResize();
    // round(0.5025... * 956) = 480, and the clamp doesn't bind (480 fits
    // well inside 956 - 204 = 752), so this rescale is a deliberate layout
    // change and 480 becomes the new preference, not just the new render.
    expect(terminalStyle(container).width).toBe("480px");

    dragExplorer(container, 600 - 240); // sidebar 240 -> 600 (post-resize width), squeeze
    await tick();
    expect(terminalStyle(container).width).toBe("392px");

    dragExplorer(container, 240 - 600); // sidebar back to 240
    await tick();
    // Recovers to 480, the preference set by the resize above — not 400,
    // which would mean the resize never actually updated it.
    expect(terminalStyle(container).width).toBe("480px");
  });

  it("the resizer's own limit is what gets recorded as the preference, not room the container has to spare afterward", async () => {
    terminalPosition.set("left");
    const { container } = renderApp();
    await tick();
    await tick();

    setAppWidth(container, 1000);
    dragExplorer(container, 200 - 240); // explorerWidth -> 200
    await tick();

    setMainSize(container, { width: 796, height: 796 });
    dragTerminal(container, 2000); // 2000px past the edge; stops at its container-relative maximum, 592
    await tick();
    expect(terminalStyle(container).width).toBe("592px");

    dragExplorer(container, EXPLORER_WIDTH_MIN - 200); // explorerWidth -> 140, room for 652
    await tick();
    // The preference is 592, not 652: there is more room now, but nothing
    // asked the panel to grow into it, only to stop being squeezed.
    expect(terminalStyle(container).width).toBe("592px");
  });
});

describe("App resizer drag lock (issue #420)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
    endDragLock();
  });

  function expectLockClear(): void {
    expect(document.documentElement.dataset.dragCursor).toBeUndefined();
  }

  it("engages col-resize for the explorer divider and clears on pointerup", async () => {
    const { container } = renderApp();
    await tick();
    await tick();
    setAppWidth(container, 2000);

    const resizer = container.querySelector(".explorer + .resizer")!;
    resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
    expect(document.documentElement.dataset.dragCursor).toBe("col-resize");

    window.dispatchEvent(pointerLikeEvent("pointermove", 50));
    expect(document.documentElement.dataset.dragCursor).toBe("col-resize");

    window.dispatchEvent(new Event("pointerup"));
    expectLockClear();
  });

  it("clears the explorer divider's lock on pointercancel and on window blur", async () => {
    const { container } = renderApp();
    await tick();
    await tick();
    setAppWidth(container, 2000);

    dragExplorer(container, 50, "pointercancel");
    expectLockClear();

    dragExplorer(container, 50, "blur");
    expectLockClear();
  });

  it.each([
    ["bottom" as const, "row-resize" as const],
    ["left" as const, "col-resize" as const],
    ["right" as const, "col-resize" as const],
  ])("engages %s dock's terminal divider with %s and clears on pointerup", async (position, expectedCursor) => {
    terminalPosition.set(position);
    explorerVisible.set(false);
    const { container } = renderApp();
    await tick();
    await tick();
    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000, height: 1000 });

    const resizer = container.querySelector(".main .resizer")!;
    resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
    expect(document.documentElement.dataset.dragCursor).toBe(expectedCursor);

    window.dispatchEvent(new Event("pointerup"));
    expectLockClear();
  });

  it("clears the terminal divider's lock on pointercancel and on window blur", async () => {
    terminalPosition.set("bottom");
    explorerVisible.set(false);
    const { container } = renderApp();
    await tick();
    await tick();
    setAppWidth(container, 1000);
    setMainSize(container, { width: 1000, height: 1000 });

    dragTerminal(container, 0, "pointercancel");
    expectLockClear();

    dragTerminal(container, 0, "blur");
    expectLockClear();
  });
});
