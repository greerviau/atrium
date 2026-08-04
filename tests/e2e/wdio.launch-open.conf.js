import { config as baseConfig } from "./wdio.conf.js";

export const config = {
  ...baseConfig,
  specs: ["./specs/launchOpen.e2e.js"],
};
