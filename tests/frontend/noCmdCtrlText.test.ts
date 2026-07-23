import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const SRC_ROOT = resolve(__dirname, "../../src");

/** Recursively lists every `.ts`/`.svelte` file under `dir`. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".svelte"))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Guards against issue #164 regressing: Atrium is Mac-only, so no
 * user-facing string should ever spell out "Cmd/Ctrl" again — every
 * shortcut label reads its glyph from `shortcutLabels.ts`. The string is
 * still allowed inside code comments describing Tauri's own `CmdOrCtrl`
 * accelerator keyword (that's Tauri's API name, not app copy), so this only
 * flags a line whose non-comment portion contains the text.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("<!--");
}

describe("no rendered 'Cmd/Ctrl' text remains in the frontend", () => {
  it("only matches inside code comments", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, index) => {
        if (line.includes("Cmd/Ctrl") && !isCommentLine(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
