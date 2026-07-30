import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import WelcomeScreen from "../../src/lib/welcome/WelcomeScreen.svelte";
import * as commands from "../../src/lib/ipc/commands";
import * as workspaceStore from "../../src/lib/stores/workspace";

vi.mock("../../src/lib/ipc/commands", () => ({
  workspaceGetRecents: vi.fn(),
  workspaceRemoveRecent: vi.fn(),
}));

vi.mock("../../src/lib/stores/workspace", () => ({
  openWorkspaceFolder: vi.fn(),
  openWorkspacePath: vi.fn(),
}));

const project = { path: "/projects/foo", name: "foo", lastOpenedAt: 1 };

describe("WelcomeScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the empty state when there are no recent projects", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([]);

    const { findByText } = render(WelcomeScreen);

    expect(await findByText("No recent projects yet")).toBeTruthy();
  });

  it("renders a recent project's name and path", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);

    const { findByText } = render(WelcomeScreen);

    expect(await findByText("foo")).toBeTruthy();
    expect(await findByText("/projects/foo")).toBeTruthy();
  });

  it("clicking Open Folder… calls openWorkspaceFolder", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([]);

    const { findByText } = render(WelcomeScreen);
    await fireEvent.click(await findByText("Open Folder…"));

    expect(workspaceStore.openWorkspaceFolder).toHaveBeenCalledOnce();
  });

  it("clicking a recent row opens it via openWorkspacePath", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);

    const { findByText } = render(WelcomeScreen);
    await fireEvent.click(await findByText("foo"));

    expect(workspaceStore.openWorkspacePath).toHaveBeenCalledWith("/projects/foo");
  });

  it("clicking remove calls workspace_remove_recent and does not open the project", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);
    vi.mocked(commands.workspaceRemoveRecent).mockResolvedValue(undefined);

    const { findByLabelText } = render(WelcomeScreen);
    await fireEvent.click(await findByLabelText("Remove foo from recent projects"));

    expect(commands.workspaceRemoveRecent).toHaveBeenCalledWith("/projects/foo");
    expect(workspaceStore.openWorkspacePath).not.toHaveBeenCalled();
  });
});
