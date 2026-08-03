import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as baseConfig } from "./wdio.conf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const launchPath = path.join(__dirname, "fixtures/launch-open.md");
const [baseCapability] = baseConfig.capabilities;

export const config = {
  ...baseConfig,
  specs: ["./specs/launchOpen.e2e.js"],
  capabilities: [
    {
      ...baseCapability,
      "tauri:options": {
        ...baseCapability["tauri:options"],
        args: [launchPath],
      },
    },
  ],
};
