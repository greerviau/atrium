import { expect } from "@wdio/globals";

describe("file-manager launch argument", () => {
  it("opens the requested file instead of the welcome screen", async () => {
    const editor = await $(".cm-content");
    await editor.waitForExist({ timeout: 10000 });

    expect(await editor.getText()).toContain("Opened from the file manager");
    expect(await $(".welcome").isExisting()).toBe(false);
  });
});
