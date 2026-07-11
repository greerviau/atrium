import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.join(__dirname, "../../src-tauri/target/debug/atrium");

let tauriDriver;

export const config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",
  capabilities: [
    {
      browserName: "wry",
      "tauri:options": {
        application: appBinary,
      },
    },
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },

  // Builds the debug binary once before the suite runs. Requires the Rust
  // toolchain and the Tauri v2 Linux/macOS system dependencies (webkit2gtk
  // + friends on Linux, or Xcode command line tools on macOS) to already be
  // installed — see tests/e2e/README.md.
  onPrepare: () => {
    const result = spawnSync("cargo", ["build"], {
      cwd: path.join(__dirname, "../../src-tauri"),
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error("cargo build failed; cannot run E2E suite");
    }
  },

  // `tauri-driver` bridges WebDriver to the app's native WebView. Install it
  // once with `cargo install tauri-driver`.
  beforeSession: () => {
    tauriDriver = spawn(path.join(process.env.HOME ?? "", ".cargo/bin/tauri-driver"), [], {
      stdio: [null, process.stdout, process.stderr],
    });
  },

  afterSession: () => {
    tauriDriver?.kill();
  },
};
