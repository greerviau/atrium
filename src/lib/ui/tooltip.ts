import type { Action } from "svelte/action";

export interface TooltipParams {
  label: string;
  shortcut?: string;
}

const SHOW_DELAY_MS = 400;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

function createTooltipEl(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "atrium-tooltip";
  el.setAttribute("role", "tooltip");
  el.style.position = "fixed";
  el.style.visibility = "hidden";
  return el;
}

function renderTooltipContent(el: HTMLDivElement, label: string, shortcut?: string): void {
  el.replaceChildren();

  const labelEl = document.createElement("span");
  labelEl.className = "atrium-tooltip-label";
  labelEl.textContent = label;
  el.appendChild(labelEl);

  if (shortcut) {
    const kbd = document.createElement("kbd");
    kbd.className = "atrium-tooltip-kbd";
    kbd.textContent = shortcut;
    el.appendChild(kbd);
  }
}

/**
 * Positions the tooltip directly above `anchor` by default, clamped to the
 * viewport, flipping below the anchor when there isn't room above — the
 * same clamp-to-viewport technique `ContextMenu.svelte` uses relative to its
 * own `anchorEl`.
 */
function positionTooltip(el: HTMLDivElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const rect = el.getBoundingClientRect();

  let top = anchorRect.top - rect.height - ANCHOR_GAP;
  if (top < VIEWPORT_MARGIN) {
    top = anchorRect.bottom + ANCHOR_GAP;
  }
  top = Math.min(top, window.innerHeight - rect.height - VIEWPORT_MARGIN);

  let left = anchorRect.left + anchorRect.width / 2 - rect.width / 2;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - rect.width - VIEWPORT_MARGIN));

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

/**
 * Shows an Atrium-styled floating tooltip on hover/focus, replacing the
 * native, unstylable `title` attribute. Used as `use:tooltip={{ label,
 * shortcut }}`. The tooltip element is a portal appended to `document.body`
 * so it's never clipped by an `overflow: hidden` ancestor (e.g. the status
 * bar), and is created only while shown — at rest, this action adds no DOM.
 */
export const tooltip: Action<HTMLElement, TooltipParams> = (node, params) => {
  let current = params;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let tooltipEl: HTMLDivElement | undefined;

  function show(): void {
    tooltipEl = createTooltipEl();
    renderTooltipContent(tooltipEl, current.label, current.shortcut);
    document.body.appendChild(tooltipEl);
    positionTooltip(tooltipEl, node);
    tooltipEl.style.visibility = "visible";
  }

  function scheduleShow(): void {
    clearTimeout(showTimer);
    showTimer = setTimeout(show, SHOW_DELAY_MS);
  }

  function hide(): void {
    clearTimeout(showTimer);
    showTimer = undefined;
    tooltipEl?.remove();
    tooltipEl = undefined;
  }

  node.addEventListener("mouseenter", scheduleShow);
  node.addEventListener("focus", scheduleShow);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("blur", hide);
  node.addEventListener("click", hide);

  return {
    update(next) {
      current = next;
      if (tooltipEl) {
        renderTooltipContent(tooltipEl, current.label, current.shortcut);
        positionTooltip(tooltipEl, node);
      }
    },
    destroy() {
      node.removeEventListener("mouseenter", scheduleShow);
      node.removeEventListener("focus", scheduleShow);
      node.removeEventListener("mouseleave", hide);
      node.removeEventListener("blur", hide);
      node.removeEventListener("click", hide);
      hide();
    },
  };
};
