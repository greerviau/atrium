import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, cleanup } from "@testing-library/svelte";
import DataPane from "../../src/lib/editor/DataPane.svelte";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  dataQuery: vi.fn(),
  isAppError: (value: unknown) => typeof value === "object" && value !== null && "message" in value,
}));

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
}));

const RESULT = {
  columns: ["name", "age"],
  rows: [["Ada", "36"], ["Grace", "28"]],
  truncated: false,
};

describe("DataPane", () => {
  beforeEach(() => {
    vi.mocked(commands.dataQuery).mockReset().mockResolvedValue(RESULT);
  });

  afterEach(() => cleanup());

  it("loads a data file into a grid with the default query", async () => {
    const { findByText, getByRole } = render(DataPane, {
      filePath: "/workspace/people.csv",
      workspaceId: "local",
    });

    expect((getByRole("textbox", { name: "SQL query" }) as HTMLTextAreaElement).value).toBe("SELECT * FROM data LIMIT 100");
    await findByText("Ada");
    expect(getByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(commands.dataQuery).toHaveBeenCalledWith("local", "/workspace/people.csv", "SELECT * FROM data LIMIT 100");
  });

  it("runs the edited SQL query from the Run button", async () => {
    const { getByRole } = render(DataPane, {
      filePath: "/workspace/people.csv",
      workspaceId: "local",
    });
    const query = getByRole("textbox", { name: "SQL query" });
    await waitFor(() => expect(commands.dataQuery).toHaveBeenCalledTimes(1));
    await fireEvent.input(query, { target: { value: "SELECT name FROM data WHERE age > 30" } });
    await fireEvent.click(getByRole("button", { name: "Run" }));

    await waitFor(() => expect(commands.dataQuery).toHaveBeenLastCalledWith(
      "local",
      "/workspace/people.csv",
      "SELECT name FROM data WHERE age > 30",
    ));
  });
});
