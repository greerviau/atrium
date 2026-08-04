import { expect } from "@wdio/globals";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.join(__dirname, "../../../src-tauri/target/debug/atrium");
const launchPath = path.join(__dirname, "../fixtures/launch-open.md");

describe("file-manager launch argument", () => {
  it("opens the requested file in the existing app instead of the welcome screen", async () => {
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
});
