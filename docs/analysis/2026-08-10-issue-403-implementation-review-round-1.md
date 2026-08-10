# Implementation review round 1: CSV/Parquet default-open (issue #403)

- **Under review:** commit `97a53ef` ("fix(platform): let .parquet and .csv default-open with Atrium") on branch `fix/parquet-csv-default-open`, the only commit ahead of `origin/main`
- **Plan:** `docs/analysis/2026-08-10-issue-403-parquet-csv-default-open-plan.md` (revision 2, approved in `docs/analysis/2026-08-10-issue-403-plan-review-round-2.md`)
- **Freshness:** `fresh:HEAD already contains origin/main`; working tree clean
- **Sources checked against:** vendored `tauri-utils` 2.9.3 (`~/.cargo/registry/src/index.crates.io-*/tauri-utils-2.9.3/src/config.rs`), the `.deb` built from this tree (`src-tauri/target/debug/bundle/deb/Atrium_0.1.0_amd64.deb`), this machine's live `shared-mime-info` database and dpkg trigger file

## Verdict

**Approve.** No must-fix items.

The implementation matches the approved plan line for line, and every empirical claim
made about it holds up when re-run independently rather than taken on report. The five
items below are all nice-to-have; none blocks merge, and none is worth a second review
round. Two of them (items 2 and 3) are simply conditions to confirm on CI before merging,
not changes to the code.

---

## Plan conformance

Checked each element of the plan against the committed diff:

| Plan item | Status |
|---|---|
| Remove `"csv"` from the "Source Code" `ext` array | Done. `.csv` is now claimed by exactly one association, `.parquet` by exactly one, `.tsv` by none (scoped out, as planned). |
| New CSV entry (`role: Viewer`, `mimeType: text/csv`, `contentTypes: ["public.comma-separated-values-text"]`) | Matches the plan snippet exactly, key for key. |
| New Parquet entry (`role: Viewer`, `mimeType: application/vnd.apache.parquet`, `exportedType` `org.apache.parquet` conforming to `public.data`) | Matches the plan snippet exactly. |
| `src-tauri/linux/atrium-mime.xml` (glob + `PAR1` magic) | Matches the plan snippet exactly. |
| `bundle.linux.deb.files` wiring, `desktopTemplate` preserved | Done; the existing `desktopTemplate` line is untouched. |
| No `postInstallScript` | Correctly dropped, per plan-review round 2's proof that the dpkg trigger makes it a strict no-op. |
| No `.tsv`, no in-app setting, no README change | All three respected. `README.md:19` already describes the data grid and says nothing about file associations. |
| e2e CSV fixture + case | Added (`tests/e2e/fixtures/launch-open.csv`, `tests/e2e/specs/launchOpen.e2e.js:30-40`). |

No scope creep: the commit touches only the three plan documents, `tauri.conf.json`, the
new MIME XML, and the e2e fixture/spec. No Rust or TypeScript source is modified, which
is consistent with the plan's central claim that the in-app routing already works.

## Claims verified independently

Everything below was re-derived here, not accepted from the implementation report.

**The config is accepted by Tauri's own parser.** `FileAssociation` carries
`#[serde(deny_unknown_fields)]` (`config.rs:1184`), so a mistyped key is a hard parse
error at build time. The `.deb` in `src-tauri/target/debug/bundle/deb/` was produced from
this tree and contains both new mime types, which is itself proof that the two new
entries parsed cleanly and that `role: "Viewer"` is a valid `BundleTypeRole` variant
(`config.rs:1103-1115`).

**The MIME XML is packaged at the right path.** `dpkg-deb -c` on the built package lists
`usr/share/mime/packages/atrium.xml` (364 bytes); extracting it yields byte-identical
content to `src-tauri/linux/atrium-mime.xml`. This settles the `deb.files` key/value
direction empirically: destination path as key, source relative to `src-tauri/` as value.

**The generated `.desktop` file advertises both types.** From the extracted package:

```
MimeType=text/markdown;text/plain;text/html;application/json;application/xml;image/svg+xml;text/plain;text/plain;text/csv;application/vnd.apache.parquet
```

**A real Parquet file resolves to the advertised type.** Installing the shipped XML into
an isolated scratch `XDG_DATA_HOME`, running `update-mime-database`, and querying:

```
$ XDG_DATA_HOME=$S/share xdg-mime query filetype t.parquet   # PAR1 header, .parquet name
application/vnd.apache.parquet
$ XDG_DATA_HOME=$S/share xdg-mime query filetype noext       # PAR1 header, no extension
application/vnd.apache.parquet
$ xdg-mime query filetype t.csv                              # system database, unmodified
text/csv
```

Both the glob rule and the magic rule fire. Nothing was written to the real MIME
database.

**The dpkg trigger really does replace the postinst.** The built package's control
archive contains only `control` and `md5sums` (no maintainer scripts at all), and
`/var/lib/dpkg/triggers/File:13` reads `/usr/share/mime/packages
shared-mime-info/noawait`. So `update-mime-database` runs on install via the trigger, and
dropping `postInstallScript` loses nothing.

**The macOS `contentTypes`/`exportedType` additions are load-bearing, not decorative.**
Traced through `tauri-utils` 2.9.3: `infer_content_types()` (`config.rs:1265`)
short-circuits and returns only the exported identifier when `exportedType` is set, so
Parquet yields `LSItemContentTypes = ["org.apache.parquet"]`. With no `exportedType`, it
unions explicit `contentTypes` with whatever `extension_to_uti` (`config.rs:1415`) and
`mime_type_to_uti` (`config.rs:1449`) can infer. I read both tables in full: neither
contains `csv`, `parquet`, `text/csv`, or `application/vnd.apache.parquet`, and
`mime_type_to_uti` matches `text/plain` exactly with no `text/*` fallback arm (unlike its
`image/`, `video/`, and `audio/` arms, which do have one). So the CSV entry yields exactly
`["public.comma-separated-values-text"]`, and without the explicit `contentTypes` it would
have yielded nothing at all — the regression flagged during plan review is genuinely
prevented.

**`npm run check` and `npm test` are green**, both run here: svelte-check reports
`780 FILES 0 ERRORS 0 WARNINGS`, and vitest reports `130 passed (130)` test files,
`1686 passed (1686)` tests.

**The `.data-pane` selector the new test waits on is unconditional**
(`DataPane.svelte:116`, outside every `{#if}`), so the assertion cannot flake on the SQL
query failing or the grid being empty.

## Not independently verified

- The Rust checks (`cargo fmt`/`clippy`/`test`) were reported green and are not re-run
  here. No Rust source changed in this commit, and the debug binary and the `.deb` were
  both built successfully from this tree, so the risk is negligible.
- Whether Atrium appears in the native "Open With" / default-apps picker on macOS or
  Windows after a real installer run. This is the same human-hardware gap PR #398
  disclosed and is not closeable from here.

---

## Nice-to-have

### 1. The new e2e assertion is weaker than its own title claims

`tests/e2e/specs/launchOpen.e2e.js:38-39` waits on `.data-pane` with `waitForExist`. But
`EditorPanel.svelte:201-202` renders *every* open tab's pane simultaneously and hides the
inactive ones with `.editor-pane-slot.hidden { display: none }`
(`EditorPanel.svelte:332-334`). So the assertion passes as long as a data-mode tab exists
anywhere in the DOM, whether or not the CSV actually became the visible pane. And the
"not the text editor" half of the test name is not asserted at all: the markdown tab from
the preceding case is still mounted, so `.cm-content` remains present regardless.

The test still catches the failure that matters — if `.csv` were routed to the text
editor, no `.data-pane` would exist and the test would fail — so this is a strengthening,
not a correctness fix. `waitForDisplayed()` instead of `waitForExist()` costs nothing and
makes the assertion mean what the title says; adding a check that the visible tab name is
`launch-open.csv` would close it completely.

### 2. The new e2e case has not been executed anywhere yet

No pull request exists for this branch yet (`gh pr list --head fix/parquet-csv-default-open`
returns empty), so CI has not run. The reported local checks (`npm run check`, `npm test`,
`npm run build`, `cargo fmt`/`clippy`/`test`) do not include the launch-open suite, and it
cannot be run on this machine: neither `tauri-driver` nor `xvfb-run` is installed, and
installing the latter needs root.

This is the only new test in the change, and CI runs it (`.github/workflows/ci.yml:73`,
Linux only). Confirm that job is green before merging rather than treating the test as
passing because it was written.

### 3. Only the `deb` bundle was built locally; CI builds `deb,appimage` together

The local verification used `--bundles deb`, but the CI Linux matrix entry is
`deb,appimage` (`ci.yml:32`). Tauri's AppImage bundler assembles its AppDir from the deb
payload, so the new `deb.files` entry will also land inside the AppImage at
`usr/share/mime/packages/atrium.xml`. That is inert (an AppImage has no install step,
which is exactly the gap the plan already discloses), and I see no mechanism by which it
would break the AppImage build — but it is unverified. The same "CI green before merge"
condition as item 2 covers it.

### 4. The commit message overstates the macOS mechanism

The message says Launch Services content types are populated "through an explicit
contentTypes entry or a declared exportedType, not automatically from the extension or
mime type". That second clause is false in general: `extension_to_uti` and
`mime_type_to_uti` do infer automatically for a hardcoded set (`png`, `pdf`, `txt`,
`json`, `xml`, `text/plain`, plus `image/*`, `video/*`, and `audio/*` fallbacks). It is
true specifically for `csv` and `parquet`, which is the actual point and the reason the
change is needed. Worth tightening to "neither Tauri's extension nor mime-type inference
table covers csv or parquet" if the PR description reuses this wording.

### 5. "Text Document" still claims CSV on macOS by UTI conformance

The plan's stated reason for pulling `csv` out of the "Source Code" entry was to avoid two
`CFBundleDocumentTypes` entries claiming the same file with conflicting
`CFBundleTypeRole`. That is achieved for the `ext`-based path, but the "Text Document"
entry (`ext: []`, `role: Editor`) declares `public.plain-text` in its `contentTypes`, and
`public.comma-separated-values-text` conforms to `public.delimited-values-text`, which
conforms to `public.plain-text`. So Launch Services still sees two matching document types
for a `.csv` file, one `Editor` and one `Viewer`.

Launch Services resolves by conformance specificity, so the new exact-match "CSV Document"
entry should win (moderate confidence; not empirically checkable without macOS hardware).
This is pre-existing behavior that predates this change and I do not recommend acting on
it — noting it only so the dedup rationale is not read as more complete than it is.

### Trivia, no action

The generated `.desktop` `MimeType=` line now contains `text/plain` three times. Tauri
joins each association's `mimeType` without deduplicating; it predates this change, and
the freedesktop spec tolerates duplicates.

## Open questions

None.
