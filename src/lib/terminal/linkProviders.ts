import type { Terminal, ILink, ILinkProvider } from "@xterm/xterm";
import { PR_LINK_REGEX } from "./prLinkRegex";
import { FILE_PATH_REGEX } from "./filePathRegex";
import { fsResolveCandidates, shellOpenExternal, type PathCandidate } from "../ipc/commands";
import { openFile } from "../stores/tabs";

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
        activate: () => void shellOpenExternal(url),
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

class FilePathLinkProvider implements ILinkProvider {
  private batcher: ResolveBatcher;

  constructor(
    private terminal: Terminal,
    private workspaceId: string,
    private cwdHint: string,
  ) {
    this.batcher = new ResolveBatcher(workspaceId);
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
    const candidates: PathCandidate[] = matches.map((m) => ({ raw: m[0], cwdHint: this.cwdHint }));
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
          activate: () => void openFile(resolvedPath, targetLine ? { line: targetLine, col } : undefined),
        });
      });
      callback(links.length > 0 ? links : undefined);
    });
  }
}

export function registerLinkProviders(terminal: Terminal, workspaceId: string, cwdHint: string): void {
  terminal.registerLinkProvider(new PrLinkProvider(terminal));
  terminal.registerLinkProvider(new FilePathLinkProvider(terminal, workspaceId, cwdHint));
}
