import type { Terminal, ILink, ILinkProvider, IMarker } from "@xterm/xterm";
import { PR_LINK_REGEX } from "./prLinkRegex";
import { FILE_PATH_REGEX } from "./filePathRegex";
import { fsResolveCandidates, shellOpenExternal, type PathCandidate } from "../ipc/commands";
import { openFileReportingErrors } from "../stores/tabs";
import { showErrorToast, describeError } from "../stores/errorToast";

/** Extracts an optional trailing `:<line>` or `:<line>:<col>` suffix from a matched candidate. */
function parseTrailingLineCol(raw: string): { path: string; line?: number; col?: number } {
  const parts = raw.split(":");
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]) && /^\d+$/.test(parts[parts.length - 2])) {
    return {
      path: parts.slice(0, -2).join(":"),
      line: Number(parts[parts.length - 2]),
      col: Number(parts[parts.length - 1]),
    };
  }
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
    return { path: parts.slice(0, -1).join(":"), line: Number(parts[parts.length - 1]) };
  }
  return { path: raw };
}

/**
 * Strips one layer of surrounding matching leading/trailing quotes from a
 * quoted-path match, preserving any trailing `:line[:col]` suffix after the
 * closing quote untouched. Returns `raw` unchanged if it isn't quoted.
 */
function unquotePathCandidate(raw: string): string {
  const quote = raw[0];
  if (quote !== "'" && quote !== '"') return raw;
  const closeIndex = raw.indexOf(quote, 1);
  if (closeIndex === -1) return raw;
  return raw.slice(1, closeIndex) + raw.slice(closeIndex + 1);
}

class PrLinkProvider implements ILinkProvider {
  constructor(private terminal: Terminal) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }
    const text = line.translateToString(true);
    const matches = [...text.matchAll(PR_LINK_REGEX)];
    if (matches.length === 0) {
      callback(undefined);
      return;
    }
    const links: ILink[] = matches.map((m) => {
      const start = m.index ?? 0;
      const url = m[0];
      return {
        range: {
          start: { x: start + 1, y: bufferLineNumber },
          end: { x: start + url.length, y: bufferLineNumber },
        },
        text: url,
        activate: (event: MouseEvent) => {
          if (!(event.metaKey || event.ctrlKey)) {
            return;
          }
          shellOpenExternal(url).catch((err: unknown) => {
            showErrorToast(`Couldn't open link: ${describeError(err)}`);
          });
        },
      };
    });
    callback(links);
  }
}

/**
 * Batches `fs_resolve_candidates` calls across all `provideLinks` calls that
 * land within a 50ms window for a given terminal, so rapid re-renders (e.g.
 * scrolling) coalesce into one IPC round trip instead of one per line.
 */
class ResolveBatcher {
  private pending: { candidates: PathCandidate[]; resolve: (r: (string | null)[]) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private workspaceId: string,
    private delayMs = 50,
  ) {}

  resolve(candidates: PathCandidate[]): Promise<(string | null)[]> {
    return new Promise((resolve) => {
      this.pending.push({ candidates, resolve });
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    });
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = [];
    this.timer = null;

    const all: PathCandidate[] = [];
    const offsets: number[] = [];
    for (const entry of batch) {
      offsets.push(all.length);
      all.push(...entry.candidates);
    }
    void fsResolveCandidates(this.workspaceId, all).then((results) => {
      batch.forEach((entry, i) => {
        const start = offsets[i];
        entry.resolve(results.slice(start, start + entry.candidates.length));
      });
    });
  }
}

/** One observed `cd`: the buffer line (tracked live via an xterm marker) where `cwd` started applying. */
interface CwdSegment {
  marker: IMarker;
  cwd: string;
}

class FilePathLinkProvider implements ILinkProvider {
  private batcher: ResolveBatcher;
  /** Append-only, one entry per `setCwdHint` call (i.e. per observed `cd`), oldest first. */
  private segments: CwdSegment[] = [];

  constructor(
    private terminal: Terminal,
    private workspaceId: string,
    /** The cwd in effect for any buffer line before the first recorded segment. */
    private spawnCwd: string,
  ) {
    this.batcher = new ResolveBatcher(workspaceId);
  }

  /**
   * Records a `cd` boundary at the terminal's current cursor line. Callers
   * must only invoke this on an actual cwd change (see TerminalPane.svelte)
   * — each call allocates a new xterm marker.
   */
  setCwdHint(cwd: string): void {
    this.segments = this.segments.filter((s) => s.marker.line !== -1);
    this.registerSegment(cwd);
  }

  /**
   * Registers a new marker for `cwd` at the terminal's current cursor line.
   * Also used to re-anchor a segment whose marker was disposed out of order
   * (see the `onDispose` handler below) rather than trimmed oldest-first as
   * scrollback trimming normally does.
   */
  private registerSegment(cwd: string): void {
    const marker = this.terminal.registerMarker();
    marker.onDispose(() => {
      // Ordinary scrollback trimming always disposes the oldest segment
      // first. But `ESC[2J` (erase-in-display) and exiting the alt screen
      // can dispose a newer marker while an older one survives — without
      // re-anchoring here, later output would then wrongly resolve against
      // the older `cd`'s cwd instead of this (still current) one.
      const wasNewest = this.segments[this.segments.length - 1]?.marker === marker;
      this.segments = this.segments.filter((s) => s.marker.line !== -1);
      if (wasNewest) {
        // Deferred to a microtask, not called synchronously: xterm's own
        // `clearMarkers`/`clearAllMarkers` iterate `Buffer.markers` while
        // re-reading its length each step, and `registerMarker` pushes onto
        // that same array — calling it synchronously from inside this
        // `onDispose` re-enters the loop that is still draining it, which
        // never terminates and hangs the whole webview. Deferring also
        // means a re-anchor triggered by leaving the alt screen lands on
        // the normal buffer, which is already active again by the time the
        // microtask runs. (If a single clear disposes two segments and the
        // older one's callback happens to run first, the newer one may
        // already be filtered out of `segments` by the time its own
        // callback checks `wasNewest`, and nothing re-anchors — an
        // acceptable degradation to `spawnCwd`, the same fallback disposal
        // already takes via ordinary trimming.)
        queueMicrotask(() => this.registerSegment(cwd));
      }
    });
    this.segments.push({ marker, cwd });
  }

  /**
   * The cwd in effect at 1-based buffer line `bufferLineNumber`: the most
   * recent segment whose marker sits at or before it, else `spawnCwd`.
   * `IMarker.line` is 0-based, hence the `- 1`.
   */
  private cwdForLine(bufferLineNumber: number): string {
    const line0 = bufferLineNumber - 1;
    this.segments = this.segments.filter((s) => s.marker.line !== -1);
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (this.segments[i].marker.line <= line0) {
        return this.segments[i].cwd;
      }
    }
    return this.spawnCwd;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }
    const text = line.translateToString(true);
    const matches = [...text.matchAll(FILE_PATH_REGEX)];
    if (matches.length === 0) {
      callback(undefined);
      return;
    }
    const cwdHint = this.cwdForLine(bufferLineNumber);
    const candidates: PathCandidate[] = matches.map((m) => ({ raw: unquotePathCandidate(m[0]), cwdHint }));
    void this.batcher.resolve(candidates).then((resolved) => {
      const links: ILink[] = [];
      matches.forEach((m, i) => {
        const resolvedPath = resolved[i];
        if (!resolvedPath) {
          return;
        }
        const start = m.index ?? 0;
        const { line: targetLine, col } = parseTrailingLineCol(m[0]);
        links.push({
          range: {
            start: { x: start + 1, y: bufferLineNumber },
            end: { x: start + m[0].length, y: bufferLineNumber },
          },
          text: m[0],
          activate: (event: MouseEvent) => {
            if (!(event.metaKey || event.ctrlKey)) {
              return;
            }
            openFileReportingErrors(resolvedPath, targetLine ? { line: targetLine, col } : undefined);
          },
        });
      });
      callback(links.length > 0 ? links : undefined);
    });
  }
}

export interface LinkProviderHandle {
  setCwdHint(cwd: string): void;
}

export function registerLinkProviders(terminal: Terminal, workspaceId: string, cwdHint: string): LinkProviderHandle {
  terminal.registerLinkProvider(new PrLinkProvider(terminal));
  const filePathProvider = new FilePathLinkProvider(terminal, workspaceId, cwdHint);
  terminal.registerLinkProvider(filePathProvider);
  return { setCwdHint: (cwd) => filePathProvider.setCwdHint(cwd) };
}
