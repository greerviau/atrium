import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    // Without this, Vite resolves Svelte's package.json `exports` to its
    // server build even under jsdom, and component tests fail with
    // "mount(...) is not available on the server".
    conditions: ["browser"],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/frontend/**/*.test.ts"],
    css: true,
  },
});
