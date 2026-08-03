import { describe, expect, it } from "vitest";
import { isDataPath, isTextPaneMode, modeForPath } from "../../src/lib/editor/codeExtensions";
import { languageLabel } from "../../src/lib/editor/languageLabel";

describe("pane modes", () => {
  it("identifies only editable source-text panes as text panes", () => {
    expect(isTextPaneMode("code")).toBe(true);
    expect(isTextPaneMode("markdown")).toBe(true);
    expect(isTextPaneMode("data")).toBe(false);
    expect(isTextPaneMode("image")).toBe(false);
  });
});

describe("image files", () => {
  it("routes browser-supported image extensions to the image pane", () => {
    for (const extension of ["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]) {
      expect(modeForPath(`/tmp/image.${extension}`)).toBe("image");
    }
    expect(modeForPath("/tmp/image.PNG")).toBe("image");
    expect(languageLabel("/tmp/image.png")).toBe("Image");
  });
});

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
