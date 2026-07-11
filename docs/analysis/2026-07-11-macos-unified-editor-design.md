# Unified macOS-first editor/terminal/notes app: design analysis

- Status: draft, awaiting disposition
- Date: 2026-07-11
- Scope: greenfield project, no existing code
- Mode: analysis / design report (no developer handoff yet)

## 1. Problem statement

The pilot currently splits a single workflow across three or more applications: a notes tool (Obsidian) for markdown, a code editor (VSCode or Zed) for source files, and a separate terminal for running Claude Code and shell commands.
Each tool is good at one thing but the seams between them cost context-switches and manual copy-paste (e.g. pasting a file path from a terminal into an editor's "open file" dialog, or a GitHub PR URL into a browser).

Two existing editors come close but each fails a specific requirement:

- VSCode and Zed treat markdown as source text with a separate raw/preview split; there is no Obsidian-style "type inside the rendered document" experience.
- Zed has added AI features (an assistant panel, inline edit prediction, multi-model support) that the pilot experiences as bloat in a tool that should stay a fast, opinionated editor plus their own terminal-driven agent (Claude Code), not a second AI surface competing with it.
- Obsidian nails edit-in-rendered-view for markdown but has no code editor, no file-explorer-as-a-project-tree in the IDE sense, and no integrated terminal.

The goal is a single, small, fast application that unifies markdown editing (Obsidian-style), a code editor, a file explorer, and an integrated terminal built specifically to run and observe Claude Code, including recognizing and acting on GitHub PR links and local file paths that Claude Code prints to the terminal.
A secondary goal is to investigate whether the same app can act as a window into a Claude Code instance running long-term on a separate machine that is not always reachable by a fixed address or open inbound port, mirroring the shape of Anthropic's own Claude Code Remote Control feature.

## 2. Requirements

### Functional

1. Markdown files open directly in a rendered, editable view; there is no separate "preview" mode or tab to toggle. Formatting (headings, emphasis, links, images, tables, task lists) renders inline while the cursor's own line shows raw markdown syntax, matching Obsidian's Live Preview behavior. The file on disk stays plain markdown at all times; the rendered view is a projection, not an alternate storage format.
2. A code editor pane provides syntax highlighting and standard editing (multi-cursor, search/replace, basic language support) for source files. Markdown and code panes should feel like the same editor with a different mode, not two different products glued together.
3. A file explorer pane shows the working directory as a tree, supports opening/creating/renaming/deleting files and folders, and reflects external changes (e.g. a git checkout, or Claude Code writing a file) live.
4. An integrated terminal pane runs a real shell (PTY-backed), used primarily to run Claude Code interactively.
5. The terminal detects, in output text, GitHub PR URLs (`https://github.com/<org>/<repo>/pull/<n>`) and local file paths (absolute or relative, with optional `:line` suffix), and renders them as clickable links. Clicking a file path opens that file in the app's own editor pane (markdown files render live, per requirement 1). Clicking a PR link opens the PR, at minimum in the system browser, with an in-app PR view considered as a later phase.
6. (Feasibility investigation only, not committed scope) A "remote control" mode where Claude Code runs long-term on a machine that is not always on the same network as the desktop app and cannot guarantee an inbound port/port-forward, and the desktop app can still open files that remote Claude Code produces or references.

### Non-functional

1. macOS-first, cross-platform preferred where it does not compromise the macOS experience or add material complexity.
2. Fast startup, low idle memory/CPU, small install size. The pilot's stated dislikes (VSCode/Zed's raw/preview split, Zed's AI feature creep, Obsidian+editor+terminal as three apps) all trace back to a single value: KISS. The app should feel closer to a lean single-purpose tool than an IDE.
3. Native look and feel on macOS (window chrome, fonts, menu bar, trackpad/scroll behavior) is preferred over an obviously "web app in a box" feel.
4. No plugin marketplace, no bundled AI chat panel, no telemetry-driven feature surface. Claude Code is the AI; the app's job is to host it well, not to duplicate it.

## 3. Evaluated approaches

### 3.1 GUI framework and language

| Option | Verdict |
|---|---|
| Tauri v2 (Rust backend + system WebView frontend) | **Recommended** |
| Native Swift/SwiftUI (with WKWebView panes for markdown/terminal) | Viable alternative, macOS-only |
| Rust-native immediate-mode GUI (egui, iced) | Rejected for this project |
| GPUI (Zed's in-house Rust UI framework) | Rejected for this project |
| Electron | Rejected |

**Electron** is rejected outright: it is the same architecture family the pilot already associates with bloat (VSCode), and Tauri gives the same web-technology leverage at a fraction of the footprint. 2026 benchmarks show Tauri v2 producing roughly 8 MB binaries versus Electron's ~150 MB, ~45 MB idle RAM versus ~280 MB, and ~0.3 s versus ~2.5 s cold start, because Tauri has no bundled Chromium or Node process tree — it uses the OS-provided WebView (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux) and a Rust backend instead of a Node one.

**GPUI** is the framework Zed itself is built on, and building this app directly on it was considered because it would produce a genuinely native-feeling, GPU-accelerated result. It's rejected for now because it is explicitly pre-1.0, documentation is thin outside Zed's own source tree, and — more importantly — choosing it means also building a markdown live-preview engine, a text editor, and a terminal widget essentially from scratch, since GPUI is a UI framework, not an editor or terminal toolkit. That is a multi-year investment to reach parity with what CodeMirror 6 and xterm.js already provide today. Rust-native immediate-mode toolkits (egui, iced) were evaluated for the same reason and rejected for the same reason, compounded by their terminal-widget ecosystem: the existing terminal widgets for both (`egui_term`, `iced_term`) are maintained by hobby projects and both describe themselves as under development without full terminal feature support — not a sound foundation for a terminal pane that must reliably host Claude Code sessions.

**Native Swift/SwiftUI** is a legitimate alternative and the most "native" option on the primary target OS. The realistic version of this option is a hybrid: SwiftUI for window chrome, the file explorer, and app shell, with WKWebView-hosted panes for the markdown editor (CodeMirror 6) and terminal (xterm.js), since a native from-scratch markdown live-preview engine and terminal emulator are exactly as large an undertaking in Swift as in GPUI. This buys slightly better OS integration than Tauri at the cost of making "cross-platform preferred" essentially unreachable (SwiftUI does not target Linux/Windows in any practical sense), and it forks the toolchain (Swift for shell, TypeScript for the embedded panes) rather than unifying on one. Given the brief states cross-platform is preferred, not required, this is noted as a follow-up if the pilot decides macOS-only, native chrome is worth more than portability.

**Recommendation: Tauri v2.** It satisfies "fast, small, not bloated" better than Electron, is dramatically less effort than GPUI or a from-scratch native build for the same result, and keeps the door open to Linux/Windows builds later at near-zero incremental architecture cost.

### 3.2 Markdown edit-in-rendered-view

Obsidian's own Live Preview is built on CodeMirror 6 (CM6): the file's plain-text markdown stays the single source of truth in the CM6 document, and a set of `Decoration`s hides markdown syntax tokens (`**`, `#`, `[...](...)`) everywhere except the line the cursor is currently on, while rendering the semantic result (bold text, a heading's font size, a clickable link) inline. This is a documented, reproducible technique — independent open-source projects (e.g. `codemirror-live-markdown`, `atomic-editor`) replicate the same approach on top of stock CM6 with no fork of the library required.

Alternatives considered:

- **ProseMirror/Milkdown-style WYSIWYG**, where the editor's native model is a structured document tree and markdown is a serialization format read/written at the edges. This is the architecture Typora and Notion-like editors use. It was set aside as the primary approach because it inverts the requirement: the brief calls for markdown to remain "first-class," i.e. the file on disk is the truth and always valid, plain, tool-agnostic markdown. A structured-document editor risks lossy or unusual round-tripping for markdown features outside its model (raw HTML blocks, footnotes, unusual table syntax), which matters if these files are also opened in git diffs, GitHub, or other markdown tools. It remains a reasonable follow-up to evaluate once the CM6 approach's edge cases are known.
- **Build a live-preview text editor from scratch.** Rejected: this is a solved, mature problem (CM6 plus the two OSS projects above already exist as reference implementations) and re-solving it has no payoff for this project.

**Recommendation: CodeMirror 6 with a Live-Preview-style decoration layer**, effectively re-implementing Obsidian's approach on top of the same underlying library Obsidian itself uses.

### 3.3 Code editor pane

Given CM6 is already the markdown engine, reusing the same CM6 instance/component for the code pane (swapping the language-mode extension and disabling the markdown decoration layer) directly satisfies the "unify, don't bolt together" goal: one editor component, two configurations, rather than two different editors that happen to sit in the same window. CM6 has mature language packages (via `@codemirror/lang-*`) for the common languages and Language Server Protocol integration is available if richer code intelligence is wanted later.

Monaco (the VSCode editor component) was considered and rejected as the default: it is heavier, brings its own opinionated IDE chrome and command palette, and duplicates capability CM6 already covers, working against the KISS goal. It remains a fallback if CM6's LSP story proves inadequate for a language the pilot cares about.

### 3.4 Terminal embedding

**xterm.js**, paired with a Rust-side PTY (`portable-pty`, the same crate WezTerm uses, or `alacritty_terminal` directly) driven from the Tauri backend, is recommended. xterm.js is the terminal implementation embedded in VSCode, Hyper, and most other Electron/Tauri-based tools; it is mature, actively maintained, and — critically for requirement 5 — already ships a link-matcher addon architecture (`@xterm/addon-web-links` plus custom `registerLinkMatcher`/link provider APIs) built exactly for "detect a pattern in terminal output, render it as a clickable link, run a callback on click." Implementing GitHub PR and local-file-path detection is a matter of registering two regex-based link providers, not building link detection from scratch.

The native Rust terminal widgets evaluated in 3.1 (`egui_term`, `iced_term`) were re-considered here specifically and rejected again: both explicitly document incomplete terminal feature support, which is disqualifying for a pane whose whole job is faithfully hosting a real Claude Code session (colors, cursor shapes, alt-screen apps, resizing, etc. all need to just work).

### 3.5 Remote control feasibility

The requirement: Claude Code (or an agent session) runs long-term on a remote machine. That machine is not guaranteed to be on the same network as the desktop app, and there is no guarantee of an inbound port or port-forward — ruling out plain SSH or a direct `ssh -L` tunnel, both of which need either an open inbound port on one side or the two machines already sharing reachability. This is precisely the problem Anthropic's own Claude Code Remote Control feature (shipped February 2026) solves: Claude keeps running locally on the user's machine, and the claude.ai/code web session or the Claude mobile app becomes "a window into that session," reachable from anywhere, without the always-on machine needing an open inbound port. The mechanism is a relay the always-on side dials out to; the viewing side also dials out to the same relay, and the relay pairs the two.

Three ways to get the same shape for this app:

- **Reuse Claude Code's actual Remote Control transport.** Not currently viable: it is not documented or exposed as a third-party integration point, only as an end-user feature of the official web/mobile clients. Worth revisiting if Anthropic exposes an SDK hook for it, but not something to design around today.
- **Build a custom relay** (a small always-on service with a public IP that both the remote daemon and the desktop app connect to outbound over WebSocket, similar in shape to `ngrok`/`frp`/`rathole`). This is the most flexible option and requires no dependency on a third party's mesh product, but it means becoming the operator of an internet-facing service: you now own its TLS, authentication, abuse-prevention, and uptime. For a single-user (or small-team) tool this is a disproportionate amount of new surface area and risk relative to the alternative below.
- **Use an existing WireGuard mesh (Tailscale, or an equivalent like Headscale/Netmaker) as the transport, with a thin custom daemon on top.** Both the remote machine and the desktop app join the same private mesh (tailnet). Tailscale's own NAT traversal already solves "no guaranteed port forwarding": it attempts direct UDP hole-punching between peers and falls back automatically to Tailscale's DERP relay network when direct connectivity isn't possible, all authenticated by the mesh's own node identity, so the app needs no separate auth system. A small purpose-built daemon then runs on the remote machine, listening only on the tailnet interface, exposing a minimal API (list/read files in an allow-listed directory, watch for changes, stream a file's content). The desktop app talks to that daemon's tailnet address exactly as it would talk to a local file source.

**Recommendation: Tailscale (or equivalent) as the transport, with a thin custom daemon.** It reuses a mature, security-audited product for the genuinely hard part (NAT traversal and relay across arbitrary networks) instead of re-implementing it, which is the lower-risk and lower-maintenance choice — directly in line with preferring quality/robustness over raw development cost. The custom-relay option is recorded as a follow-up for a future "I don't want a Tailscale dependency" variant, and reusing Claude Code's own transport is recorded as a follow-up contingent on Anthropic exposing it.

Scope note: this phase gives the desktop app read access to files a remote Claude session produces or references (e.g. clicking a markdown link that resolves to a path on the remote machine). It does not, in this design, route the desktop app's terminal pane to *control* that remote Claude session interactively — that is a materially bigger feature (needs its own PTY-over-mesh transport, reconnect/resume semantics, and multi-writer conflict handling) and is called out as an open question in section 8 rather than committed scope.

## 4. Recommended architecture and tech stack

```
┌───────────────────────────────────────────────────────────┐
│ Tauri v2 app (macOS first; Linux/Windows buildable later) │
│                                                             │
│  Rust backend (src-tauri/)                                 │
│   - window/menu/app-shell                                  │
│   - filesystem: read/write/watch (notify crate)             │
│   - PTY host per terminal pane (portable-pty)               │
│   - remote daemon client (tailnet), phase 3 only            │
│                                                             │
│  WebView frontend (system WKWebView on macOS)               │
│   - CodeMirror 6: markdown pane (live-preview decorations)  │
│   - CodeMirror 6: code pane (language modes, no decorations)│
│   - xterm.js: terminal pane + link-provider addons           │
│      (GitHub PR regex, local file-path regex)                │
│   - file explorer tree component                             │
│   - thin app shell (panes/tabs/layout), no framework bloat   │
│     (a minimal reactive layer, e.g. Svelte, is enough —       │
│      this is not an app that needs React/Redux-scale state)  │
└───────────────────────────────────────────────────────────┘
                          │ (phase 3)
                          │ tailnet (WireGuard, NAT-traversed)
                          ▼
┌───────────────────────────────────────────────────────────┐
│ Remote machine                                              │
│  - user's existing long-running Claude Code session          │
│    (tmux/systemd/etc., outside this app's control)            │
│  - small Rust daemon, tailnet-only listener:                  │
│    list/read/watch files in an allow-listed directory tree    │
└───────────────────────────────────────────────────────────┘
```

Frontend/backend split follows Tauri's normal `invoke`/event-channel model: the WebView never touches the filesystem or PTYs directly, it asks the Rust backend via typed commands and receives file-change/terminal-output events as they happen.

Link detection lives entirely in the frontend (xterm.js link providers run over the text xterm.js already renders); resolving a clicked local-file link to "open in editor pane" or "resolve against the remote daemon" is a Rust-backend decision based on whether the workspace is local or a phase-3 remote workspace.

## 5. MVP feature scope vs. later phases

**MVP (phase 1 — local only, macOS build)**

- Single window, three-pane layout: file explorer, tabbed editor area (markdown + code), terminal pane.
- Markdown pane: CM6 + live-preview decorations covering headings, emphasis, links, images, inline code, code blocks, lists (ordered/unordered/task).
- Code pane: CM6 with per-file-extension language mode and standard editing (multi-cursor, find/replace).
- File explorer: tree view over the open folder, backed by `notify` for live updates; open/create/rename/delete.
- Terminal: xterm.js + `portable-pty`-hosted shell, used to run Claude Code directly; GitHub-PR-link and local-file-path link providers wired to "open in system browser" and "open in editor pane" respectively.
- macOS build only; no code-signing/notarization required for local/personal use.

**Phase 2 (polish + portability)**

- Linux and Windows Tauri builds (packaging/signing per platform; the architecture in section 4 needs no redesign for this).
- In-app GitHub PR viewer pane (via the `gh` CLI or GitHub REST API) as an alternative to shelling out to the system browser.
- Session/workspace persistence (reopen last folder, tabs, terminal panes).
- Settings: theme, font, keybindings.
- macOS notarization/signing for distribution beyond the pilot's own machine.

**Phase 3 (remote control feasibility → implementation)**

- Remote daemon (Rust binary) installable on the remote machine, joining a Tailscale tailnet, allow-listed to specific directories.
- Desktop app gains a "remote workspace" concept: connect to a daemon's tailnet address, browse and open its files (read-only to start).
- Terminal link providers extended so a file path a remote Claude session prints resolves against the correct workspace (local vs. the connected remote one).
- Explicitly deferred within phase 3: interactive control of the remote Claude Code session's own terminal through this app (see section 6, open question 3).

## 6. Testing / validation strategy

Since this is a design document rather than an implementation, "testing" here means how to validate the approach before investing further:

1. Before committing to CM6 live-preview, build a throwaway spike against the pilot's own real notes (not synthetic examples), specifically covering nested lists, tables, fenced code blocks inside list items, and any wikilink-style syntax the pilot actually uses in Obsidian today. This is the single highest-risk unknown in the whole design (see section 7, risk 1) and should be validated first, before the file-explorer or terminal work, since it is the piece with no off-the-shelf drop-in solution.
2. Validate the xterm.js link-provider approach against real Claude Code terminal output (not hand-written test strings), since Claude Code's actual PR-link and file-path formatting in the terminal needs to be observed directly to write correct regexes.
3. Validate Tailscale's relay fallback behavior (not just direct connection) by testing phase 3 across two networks that are both known to be behind NAT with no port forwarding, to confirm the DERP-relay fallback path actually delivers acceptable file-open latency, not just the happy-path direct connection.
4. Ordinary engineering testing (unit tests around the Rust backend's file/PTY/link-resolution logic, component-level tests for the CM6 decoration layer) applies once implementation starts; not elaborated further here since this is analysis, not a build plan.

## 7. Open risks and questions for the pilot

1. **Markdown live-preview fidelity is the biggest unknown.** The reference OSS projects (`atomic-editor`, `codemirror-live-markdown`) are small, relatively young projects, not a battle-tested library like CM6 or xterm.js themselves. Reaching Obsidian-level polish across all the markdown the pilot actually writes may need real engineering investment beyond wiring up an existing package, not just glue code. Recommend treating this as the first spike (see section 6).
2. **Cross-platform WebView fidelity.** Tauri's Linux backend uses WebKitGTK, which has historically trailed WKWebView (macOS) and WebView2 (Windows) in CSS/font rendering and feature support. This mainly affects the phase-2 "cross-platform preferred" goal, not the macOS-first MVP, but worth setting expectations that a Linux build may need visual QA passes the macOS build doesn't.
3. **How much "remote control" is actually wanted?** Section 3.5/phase 3 as scoped only gives the desktop app read access to a remote Claude session's output files, mirroring "open the markdown file Claude linked to." A materially bigger version of this feature would let the desktop app's own terminal pane attach to and interactively drive the remote Claude Code session itself (not just read its output) — that needs PTY-over-mesh streaming, reconnect/resume semantics, and thinking through what happens if the local terminal and something else on the remote machine both attach at once. Worth confirming with the pilot which version is actually wanted before phase 3 is scoped in detail.
4. **In-app PR viewer scope (phase 2).** Rendering a full PR (diff, comments, review state) in-app is a meaningfully larger surface than deep-linking to the system browser or shelling out to `gh pr view` in a side pane. Recommend starting with the cheaper option and only building a richer in-app viewer if the browser round-trip proves annoying in practice.
5. **Distribution.** Even for personal use, an unsigned macOS app trips Gatekeeper warnings on first run; if the pilot wants to install this on more than one of their own machines without repeated manual overrides, Apple Developer ID signing and notarization (a recurring $99/year cost plus a build-pipeline step) should be budgeted into phase 2, not treated as a footnote.
6. **Frontend framework choice inside the WebView.** Section 4 suggests a minimal reactive layer (e.g. Svelte) rather than React, in keeping with the KISS goal — this is a low-stakes, easily-revisited choice and is flagged here only so it's an explicit decision rather than a default.

## 8. Proposed project name

**Atrium** — the architectural metaphor is a shared central hall that separate rooms open onto, rather than separate buildings connected by hallways. That maps directly onto the goal: markdown, code, files, and the terminal are rooms off one atrium, not three different apps the pilot has to walk between. It's short, easy to say and type, and not already strongly associated with a competing editor or terminal product (unlike, e.g., "Warp," which is a real terminal app).
This is a temporary/working codename, expected to be revisited before any public release.
