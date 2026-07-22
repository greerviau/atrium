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

export function handleTerminalKeyEvent(
  event: KeyboardEvent,
  { isMacPlatform, writeToPty }: TerminalKeyEventHandlerOptions,
): boolean {
  const key = event.key.toLowerCase();
  const hasToggleModifier = isMacPlatform ? event.metaKey : event.ctrlKey && !event.metaKey;
  const isToggleAccelerator = hasToggleModifier && (key === "b" || key === "r");
  if (isToggleAccelerator) return false;

  if (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    writeToPty(ESC_CR);
    return false;
  }

  return true;
}
