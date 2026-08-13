import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.join(
  __dirname,
  `../../src-tauri/target/debug/atrium${process.platform === "win32" ? ".exe" : ""}`,
);

let frontendServer;
let tauriDriver;
let dataHomeDir;

function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function waitForFrontend() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:1420");
      if (response.ok) return;
    } catch {
      // Vite has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite did not become ready on port 1420");
}

export const config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",
  capabilities: [
    {
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

  // The debug binary loads Tauri's configured devUrl, so the harness owns
  // both Vite and the Rust build. Requires the Rust toolchain and the Tauri
  // v2 Linux/Windows system dependencies (webkit2gtk + friends on Linux, or
  // WebView2 and C++ Build Tools on Windows) to already be installed.
  onPrepare: async () => {
    // A fresh, per-run webview profile. Without this, the app's persisted
    // `atrium.editorSession` (open tabs, split-pane tree) and `recents.json`
    // carry over from whatever a *previous run* of this suite left behind —
    // `restoreTabsOnStartup` defaults to true, and `openWorkspace`'s
    // `browser.refresh()` picks up whatever the profile already has, so a
    // stale session from an earlier run silently changes what a spec sees.
    // Set before `beforeSession` spawns `tauri-driver`, so the app process
    // inherits it from the start.
    dataHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), `atrium-e2e-${process.pid}-`));
    process.env.XDG_DATA_HOME = dataHomeDir;

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    frontendServer = spawn(npm, ["run", "dev", "--", "--host", "127.0.0.1"], {
      cwd: path.join(__dirname, "../.."),
      detached: true,
      stdio: "inherit",
    });

    try {
      await waitForFrontend();
      const result = spawnSync("cargo", ["build"], {
        cwd: path.join(__dirname, "../../src-tauri"),
        stdio: "inherit",
      });
      if (result.status !== 0) {
        throw new Error("cargo build failed; cannot run E2E suite");
      }
    } catch (error) {
      stopProcessTree(frontendServer);
      throw error;
    }
  },

  // `tauri-driver` bridges WebDriver to the app's native WebView. Install it
  // once with `cargo install tauri-driver`. `cargo install`'s target
  // directory is `$HOME` on Linux/macOS but `%USERPROFILE%` on Windows —
  // Node's `process.env.HOME` isn't reliably set there.
  beforeSession: () => {
    const cargoHome = process.env.CARGO_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cargo");
    const driverName = process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver";
    tauriDriver = spawn(path.join(cargoHome, "bin", driverName), [], {
      stdio: [null, process.stdout, process.stderr],
    });
  },

  afterSession: () => {
    tauriDriver?.kill();
  },

  onComplete: () => {
    stopProcessTree(frontendServer);
    if (dataHomeDir) {
      fs.rmSync(dataHomeDir, { recursive: true, force: true });
    }
  },
};
