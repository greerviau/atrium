import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/app.css";
import { initTheme } from "./lib/stores/theme";

// Resolves and applies the persisted (or OS-resolved, for Auto) theme before
// the app ever mounts, so the first paint of real content already has the
// right palette instead of flashing from :root's Atrium Dark default.
await initTheme();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
