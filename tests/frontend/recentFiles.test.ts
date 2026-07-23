import { describe, it, expect, beforeEach } from "vitest";
import { recordFileOpened, getRecentFiles } from "../../src/lib/stores/recentFiles";

describe("recentFiles", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty list for a workspace with no recorded opens", () => {
    expect(getRecentFiles("/proj")).toEqual([]);
  });

  it("records an opened file at the front of the list", () => {
    recordFileOpened("/proj", "/proj/a.txt");
    expect(getRecentFiles("/proj")).toEqual(["/proj/a.txt"]);
  });

  it("moves a re-opened file back to the front instead of duplicating it", () => {
    recordFileOpened("/proj", "/proj/a.txt");
    recordFileOpened("/proj", "/proj/b.txt");
    recordFileOpened("/proj", "/proj/a.txt");

    expect(getRecentFiles("/proj")).toEqual(["/proj/a.txt", "/proj/b.txt"]);
  });

  it("caps the list at 20 entries, dropping the oldest", () => {
    for (let i = 0; i < 25; i++) {
      recordFileOpened("/proj", `/proj/file${i}.txt`);
    }

    const recent = getRecentFiles("/proj");
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("/proj/file24.txt");
    expect(recent).not.toContain("/proj/file0.txt");
    expect(recent).not.toContain("/proj/file4.txt");
  });

  it("keeps each workspace root's recent files separate", () => {
    recordFileOpened("/proj-a", "/proj-a/a.txt");
    recordFileOpened("/proj-b", "/proj-b/b.txt");

    expect(getRecentFiles("/proj-a")).toEqual(["/proj-a/a.txt"]);
    expect(getRecentFiles("/proj-b")).toEqual(["/proj-b/b.txt"]);
  });

  it("tolerates corrupted localStorage content instead of throwing", () => {
    localStorage.setItem("atrium.recentFiles./proj", "not json");
    expect(getRecentFiles("/proj")).toEqual([]);
  });
});
