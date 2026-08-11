import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `path.join` against the dirname, not `new URL("../e2e/", import.meta.url)`:
// under vitest's jsdom environment, the global `URL` constructor resolves a
// relative second argument against jsdom's own fake `http://localhost:3000/`
// origin rather than the file:// base actually passed, silently producing a
// non-file URL.
const e2eRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../e2e/");

// Every line of every E2E source file, paired with the file it came from.
//
// Covers `helpers/` as well as `specs/`, and recurses, because the selector
// idiom now lives centrally: a mistake made once in `helpers/selectors.js`
// would reach every spec at once. `wdio.conf.js`'s own glob is
// `./specs/**/*.e2e.js`, so a nested spec is legal and must be scanned.
//
// Single-line `//` comments are dropped: the prose explaining this trap
// legitimately quotes the broken forms. Block and JSDoc comments are not
// stripped, so keep such prose in `//` form inside these directories.
function e2eSourceLines(): Array<{ file: string; number: number; line: string }> {
  return ["specs", "helpers"].flatMap((dir) => {
    const root = path.join(e2eRoot, dir);
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".js"))
      .flatMap((name) =>
        fs
          .readFileSync(path.join(root, name), "utf8")
          .split("\n")
          .map((line, index) => ({ file: `${dir}/${name}`, number: index + 1, line }))
          .filter(({ line }) => !line.trimStart().startsWith("//")),
      );
  });
}

const at = ({ file, number }: { file: string; number: number }) => `${file}:${number}`;

// Extracts the content of every quoted or template string literal on a line,
// so the selector-shaped guards below test what a selector string actually
// contains rather than the surrounding JS.
function stringLiterals(line: string): string[] {
  const literals: string[] = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    literals.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return literals;
}

// WebdriverIO's `=text` / `*=text` text-match strategy is only recognized
// when the part before the `=` is a single compound selector; a descendant
// combinator in front of it (e.g. `.close-prompt-panel button=Save`) is
// forwarded as raw CSS instead, which WebKitWebDriver rejects. The
// compound-only forms (`[role="menuitem"]=Save`, `[role="menuitem"]*=Save`)
// are legal and must not be flagged, so `=` occurring inside a `[...]`
// attribute selector (a CSS attribute operator, not a text match) is
// excluded — tracked with bracket depth rather than a bare `=` scan.
function hasCombinatorBeforeTextMatch(selector: string): boolean {
  let depth = 0;
  let lastOutsideBracketEquals = -1;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "=" && depth === 0 && selector[i - 1] !== "=" && selector[i + 1] !== "=") {
      lastOutsideBracketEquals = i;
    }
  }
  if (lastOutsideBracketEquals === -1) return false;
  return /\s/.test(selector.slice(0, lastOutsideBracketEquals));
}

// Svelte's scoping hash means an element styled by its own component always
// carries a second class token, so `@class='foo'` equality never matches and
// the selector silently waits out its timeout instead of failing loudly. This
// defect was copy-pasted into seven specs before anyone noticed (issue #412).
describe("e2e selectors", () => {
  it("never match an element by exact class equality", () => {
    const offenders = e2eSourceLines()
      .filter(({ line }) => /@class\s*=\s*['"]/.test(line))
      .map(at);

    expect(offenders).toEqual([]);
  });

  // `contains()` looks like it solves the scoping-hash problem, and it does not.
  // Two distinct ways it silently fails, both already shipped here:
  //
  //   - Multi-token literals never match. Svelte appends `class:`-directive
  //     tokens *after* the scoping hash, so an active tab renders
  //     `class="tab svelte-w72ddb active"` and `contains(@class, 'tab active')`
  //     is false — the tokens are not adjacent (issue #412).
  //   - Single-token literals match too much. `contains()` is a substring test,
  //     so `contains(@class, 'cm-line')` also matches `cm-lineWrapping`, which
  //     CodeMirror puts on `.cm-content` — the ancestor of every line, holding
  //     all of their text, and first in document order (issue #424).
  //
  // There is no sound bare form. Use `.tab.active` (CSS, token-matched by
  // specification) or `hasClass()` from `helpers/selectors.js`. `hasClass()`
  // itself does not trip this: its `contains()` first argument is `concat(...)`,
  // not `@class`.
  it("never test a class with a bare contains(@class, …)", () => {
    const offenders = e2eSourceLines()
      .filter(({ line }) => /contains\(\s*@class\b/.test(line))
      .map(at);

    expect(offenders).toEqual([]);
  });

  // `browser.keys(["Meta", ...])` delivers the Super key on Linux and Windows,
  // not `CmdOrCtrl` — this target only ever runs there. Use `Control` for a
  // DOM-level chord, or `invokeMenuCommand` (`helpers/menu.js`) for a native
  // `main.rs` accelerator, which WebDriver cannot reach with any modifier
  // (issue #421 group 3).
  it("never sends a Meta chord", () => {
    const offenders = e2eSourceLines()
      .filter(({ line }) => stringLiterals(line).some((literal) => literal === "Meta"))
      .map(at);

    expect(offenders).toEqual([]);
  });

  // WebKitWebDriver's Get Element Text returns "" for any element with
  // `overflow: hidden`, however visible and non-empty it is. `.tab-name` and
  // the status bar's path are both deliberately clipped — read them with
  // `elementText()` (`helpers/text.js`), which reads `textContent` through
  // the DOM instead.
  it("never reads a clipped selector's text via getText()/toHaveText…()", () => {
    const clippedSelector = /\.tab-name|\.status-item\.path|\.status-bar\s*\.path/;
    const clippedTextRead = /\.getText\(\)|toHaveText\(/;
    const offenders = e2eSourceLines()
      .filter(({ line }) => clippedSelector.test(line) && clippedTextRead.test(line))
      .map(at);

    expect(offenders).toEqual([]);
  });

  // Atrium only ships for macOS, so every `aria-label` is a Mac glyph
  // (`shortcutLabels.ts`) — there is no "Cmd/Ctrl+" text anywhere in the app,
  // on any platform. Match the label's stable prefix instead (e.g.
  // `aria-label^="Search ("`), per §4.4.
  it("never selects on a literal Cmd/Ctrl+ aria-label", () => {
    const offenders = e2eSourceLines()
      .filter(({ line }) => /Cmd\/Ctrl\+/.test(line))
      .map(at);

    expect(offenders).toEqual([]);
  });

  it("never precedes a =text / *=text match with a descendant combinator", () => {
    const offenders = e2eSourceLines()
      .filter(({ line }) => stringLiterals(line).some(hasCombinatorBeforeTextMatch))
      .map(at);

    expect(offenders).toEqual([]);
  });

  // `.pane-leaf`, `.pane-body`, `.tab`, `.tab-name`, `.tab-close` and
  // `.tab-list` are all rendered by both the editor's and the terminal's
  // split trees (issue #421 group 2, §2.9): an unscoped top-level `$()`/`$$()`
  // selector using one of them can silently resolve to the wrong surface,
  // since document order — not relevance — decides which match comes back.
  // Scope to `.editor-panel` / `.editor-area` / `.terminal-area` as
  // appropriate. Querying from an already-scoped element handle
  // (`someHandle.$(...)`) is unambiguous by construction and is not flagged.
  it("scopes dual-surface tab/pane classes to editor or terminal", () => {
    const topLevelSelectorCall = /(?<![.\w])\$\$?\(/;
    const dualSurfaceToken = /\.pane-leaf\b|\.pane-body\b|\.tab\b|\.tab-name\b|\.tab-close\b|\.tab-list\b/;
    const scoped = /\.editor-panel|\.editor-area|\.terminal-area/;
    const offenders = e2eSourceLines()
      .filter(({ line }) => topLevelSelectorCall.test(line) && dualSurfaceToken.test(line) && !scoped.test(line))
      .map(at);

    expect(offenders).toEqual([]);
  });

  // Removed in WebdriverIO v9 (the suite is pinned to 9.30.1); it throws
  // `TypeError: ... is not a function` the moment execution reaches it. The
  // v9 idiom is `toHaveText(expect.stringContaining(...))`, already used at
  // `horizontalRuleCursor.e2e.js:33`.
  it("never uses the removed toHaveTextContaining matcher", () => {
    const offenders = e2eSourceLines()
      .filter(({ line }) => /toHaveTextContaining/.test(line))
      .map(at);

    expect(offenders).toEqual([]);
  });
});
