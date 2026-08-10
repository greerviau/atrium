import { expect } from "@wdio/globals";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.join(__dirname, "../../../src-tauri/target/debug/atrium");
const launchPath = path.join(__dirname, "../fixtures/launch-open.md");
const csvLaunchPath = path.join(__dirname, "../fixtures/launch-open.csv");

describe("file-manager launch argument", () => {
  it("opens the requested file in the existing app instead of the welcome screen", async () => {
    const welcome = await $(".welcome");
    await welcome.waitForExist({ timeout: 10000 });

    const secondInstance = spawnSync(appBinary, [launchPath], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(secondInstance.error).toBeUndefined();
    expect(secondInstance.status).toBe(0);

    const editor = await $(".cm-content");
    await editor.waitForExist({ timeout: 10000 });

    expect(await editor.getText()).toContain("Opened from the file manager");
    expect(await $(".welcome").isExisting()).toBe(false);
  });

  it("opens a CSV launch argument in the data pane, not the text editor", async () => {
    const thirdInstance = spawnSync(appBinary, [csvLaunchPath], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(thirdInstance.error).toBeUndefined();
    expect(thirdInstance.status).toBe(0);

    const dataPane = await $(".data-pane");
    await dataPane.waitForDisplayed({ timeout: 10000 });
  });
});
