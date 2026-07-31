import { describe, expect, it } from "vitest";
import { isDataPath, modeForPath } from "../../src/lib/editor/codeExtensions";
import { languageLabel } from "../../src/lib/editor/languageLabel";

describe("tabular data files", () => {
  it("route CSV, TSV, and Parquet files to the data pane", () => {
    expect(modeForPath("/tmp/people.CSV")).toBe("data");
    expect(modeForPath("/tmp/people.tsv")).toBe("data");
    expect(modeForPath("/tmp/people.parquet")).toBe("data");
    expect(modeForPath("/tmp/people.json")).toBe("code");
  });

  it("exposes the supported data extensions and status labels", () => {
    expect(isDataPath("people.csv")).toBe(true);
    expect(isDataPath("people.txt")).toBe(false);
    expect(languageLabel("people.csv")).toBe("CSV");
    expect(languageLabel("people.parquet")).toBe("Parquet");
  });
});
