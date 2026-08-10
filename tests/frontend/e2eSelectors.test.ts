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

  // The near-miss fix: `contains()` looks like it solves the hash problem, but
  // Svelte appends `class:` directive tokens *after* the hash, so an active tab
  // renders `class="tab svelte-w72ddb active"` and `contains(@class, 'tab
  // active')` never matches either. A multi-token literal inside `contains()`
  // is therefore always wrong — use `.tab.active` (CSS) or compose one
  // `hasClass` call per token.
  it("never test a multi-token class literal with contains()", () => {
    const offenders = e2eSourceLines()
      .filter(({ line }) => /contains\(\s*@class\s*,\s*['"][^'"]*\s[^'"]*['"]\s*\)/.test(line))
      .map(at);

    expect(offenders).toEqual([]);
  });
});
