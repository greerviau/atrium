// xterm.js's default keymap always encodes Enter as CR (or ESC CR for
// Alt+Enter); it never consults shiftKey, since Shift only changes which
// character a key produces and Enter's character is already a control code.
// Ink-based multi-line prompts (Claude Code's CLI among them) already treat
// ESC CR as "insert newline, don't submit," so a bare Shift+Enter is
// remapped to that sequence here instead, ahead of xterm's own encoding.
const ESC_CR = "\x1b\r";

export interface TerminalKeyEventHandlerOptions {
  isMacPlatform: boolean;
  writeToPty: (data: string) => void;
}

const SPLIT_ARROW_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright"]);

export function handleTerminalKeyEvent(
  event: KeyboardEvent,
  { isMacPlatform, writeToPty }: TerminalKeyEventHandlerOptions,
): boolean {
  const key = event.key.toLowerCase();
  const hasToggleModifier = isMacPlatform ? event.metaKey : event.ctrlKey && !event.metaKey;
  const isToggleAccelerator = hasToggleModifier && (key === "b" || key === "r");
  if (isToggleAccelerator) return false;

  // The four new split-direction accelerators (⌥⌘↑/↓/←/→, issue #156) are
  // Option+Cmd+Arrow — xterm.js's default keymap otherwise treats a bare
  // Alt+Arrow as a word-navigation escape sequence, which would swallow the
  // chord before it ever reaches `main.rs`'s native accelerator table.
  const hasSplitModifier = isMacPlatform ? event.metaKey && event.altKey : event.ctrlKey && event.altKey && !event.metaKey;
  if (hasSplitModifier && SPLIT_ARROW_KEYS.has(key)) return false;

  if (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    // Returning `false` only tells xterm.js's own _keyDown to skip its default
    // encoding — it does not call preventDefault/stopPropagation the way
    // xterm's own cancel() does for the keys it handles itself, so without
    // this the browser's native "insert a newline" default action for a
    // textarea still runs against xterm's hidden input element.
    event.preventDefault();
    event.stopPropagation();
    writeToPty(ESC_CR);
    return false;
  }

  return true;
}
