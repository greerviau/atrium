# Plan: let CSV and Parquet default-open with Atrium (issue #403)

**Revision 2** — incorporates round-1 findings
(`docs/analysis/2026-08-10-issue-403-plan-review.md`). Both must-fix items
are adopted as recommended; see "Changes from revision 1" at the bottom.
Every factual claim below that touches Tauri's bundler internals was
independently re-verified against the vendored `tauri-utils` 2.9.3 source
(`~/.cargo/registry/.../tauri-utils-2.9.3/src/config.rs`) and this machine's
live `shared-mime-info` database — not taken on the reviewer's word.

## Problem

Issue #362/PR #398 built the infrastructure that lets the OS launch Atrium
with a double-clicked file: `bundle.fileAssociations` in
`src-tauri/tauri.conf.json` registers Atrium with the OS, and
`src-tauri/src/launch_open.rs` routes the resulting launch argument or
`RunEvent::Opened` path into the app regardless of extension. Once a file
type is registered, the OS's own "Open With" / "Get Info" / "Default apps"
picker offers Atrium and lets the user set it as the default — that picker
*is* the "configure as default" UI. No prior issue added a second, in-app
"set as default" setting, and there is none anywhere in the settings menu
today (checked `src/lib/settings/settingsRegistry.ts` and
`SettingsDialog.svelte`), so this plan doesn't invent one.

Both `.csv` and `.parquet` already open correctly *inside* Atrium —
`modeForPath`/`isDataPath` (`src/lib/editor/codeExtensions.ts:10-28`) route
both (plus `.tsv`) to `DataPane.svelte`'s read-only query grid (one backend
call, `dataQuery`, no write path), per PR #383.

What today's `fileAssociations` array (`tauri.conf.json:32-84`) actually
registers, per platform:

- **`.parquet`: nothing.** It's in no entry at all, so Atrium never appears
  as an "Open With" candidate for it, on any platform.
- **`.csv`: registered, but inaccurately.** It rides in the generic "Source
  Code" entry (`tauri.conf.json:41-60`, extension at line 47) with
  `mimeType: "text/plain"` and `role: "Editor"` — both wrong: the correct
  type is `text/csv`, and CSV opens read-only in the data-query pane, not
  the text editor.

Registration itself is platform-specific in a way this repo hasn't needed
to reason about until now, because every extension added since PR #398 has
been a plain-text type the OS already recognizes:

- **Linux** never reads the `ext` array — `linux/main.desktop.hbs` emits
  `MimeType={{mime_type}}` verbatim, and a `.desktop` `MimeType=` line only
  matches a file if the desktop environment's own `shared-mime-info`
  database independently classifies it as that type. `text/csv` is a real,
  pre-existing `shared-mime-info` type (confirmed live: `xdg-mime query
  filetype x.csv` → `text/csv`), so CSV needs nothing further. Parquet has
  **no** entry anywhere in `shared-mime-info` (confirmed: zero hits across
  `/usr/share/mime/{globs,globs2,magic,aliases,subclasses,packages/*.xml}`;
  `xdg-mime query filetype` on a real 4-byte-`PAR1`-header file returns
  `application/octet-stream`). Registering `application/vnd.apache.parquet`
  in the `.desktop` file alone is a no-op: the system has never heard of
  that type, so no real `.parquet` file ever resolves to it, and Atrium
  never becomes a recommended (or even "Other Applications"-selectable
  under the right type) opener. This needs its own fix — see "Change" §2.
- **macOS** builds `CFBundleDocumentTypes` from every association
  (`file_associations_plist()`, `config.rs:1302`), but the `LSItemContentTypes`
  key inside each entry — the thing Launch Services actually keys "Open
  With" candidacy on — is populated by `infer_content_types()`
  (`config.rs:1265`), which only ever contributes something if: an explicit
  `contentTypes` is set, the extension is one of a dozen hardcoded values in
  `extension_to_uti()` (`config.rs:1415`, images/video/audio/pdf/txt/rtf/
  html/json/xml only), the `mimeType` exactly matches one of a similarly
  short hardcoded list in `mime_type_to_uti()` (`config.rs:1449` —
  `text/plain` matches exactly, with **no** `text/*` fallback, unlike the
  `image/*`/`video/*`/`audio/*` arms which do have one), or an
  `exportedType` is set (in which case its `identifier` is used instead of
  everything else). None of `csv`, `parquet`, `text/csv`, or
  `application/vnd.apache.parquet` appear in either table. As written, both
  new entries would emit **no** `LSItemContentTypes` at all — and for CSV
  that's a regression from today, where riding in "Source Code" gives it
  `public.plain-text` via the `text/plain` exact match. (Separately:
  `UTExportedTypeDeclarations` is built only from associations that set
  `exportedType` — none do today — so PR #398 registered
  `CFBundleDocumentTypes` on macOS, not `UTExportedTypeDeclarations`; the
  latter key doesn't exist in the built plist yet. `exportedType` is also
  not something Tauri synthesizes from `ext`+`mimeType` on its own — it has
  to be declared per association, which is exactly what §1 below does for
  Parquet.) This needs a `contentTypes`/`exportedType` fix — see "Change" §1.
- **Windows** NSIS registers each `ext` value to a ProgID from this same
  array — mechanically fine for both new extensions once they're not also
  claimed by "Source Code".

## Change

### 1. `tauri.conf.json`: dedicated CSV and Parquet entries

Remove `"csv"` from the "Source Code" entry's `ext` array
(`tauri.conf.json:47`). Add two new entries:

```json
{
  "ext": ["csv"],
  "name": "CSV Document",
  "description": "CSV Document",
  "role": "Viewer",
  "rank": "Alternate",
  "mimeType": "text/csv",
  "contentTypes": ["public.comma-separated-values-text"]
},
{
  "ext": ["parquet"],
  "name": "Parquet Document",
  "description": "Parquet Document",
  "role": "Viewer",
  "rank": "Alternate",
  "mimeType": "application/vnd.apache.parquet",
  "exportedType": {
    "identifier": "org.apache.parquet",
    "conformsTo": ["public.data"]
  }
}
```

- `mimeType: "text/csv"` / `"application/vnd.apache.parquet"` — the correct
  registered types (the Parquet one is Apache's IANA registration,
  2024-02-14); `text/csv` is what Linux's own MIME database already
  recognizes.
- `role: "Viewer"` (new to this file — every existing entry uses
  `"Editor"`) reflects that `DataPane` is read-only; Atrium isn't offering
  itself as a CSV/Parquet *editor*. `rank: "Alternate"` matches every
  existing entry.
- `contentTypes: ["public.comma-separated-values-text"]` for CSV — the
  system UTI for CSV already exists on macOS (conforms to
  `public.delimited-values-text` / `public.plain-text`), so an explicit
  reference is enough; no `exportedType` needed, matching the existing
  "Text Document" entry's own use of `contentTypes` (`tauri.conf.json:76-82`)
  for the same reason.
- `exportedType` for Parquet — `.parquet` has no system UTI, which is
  exactly the case Tauri's own doc comment on `exportedType` describes
  ("define this if the associated file is a custom type"), and it's the
  only mechanism that gets `application/vnd.apache.parquet` into the built
  `Info.plist` at all (`file_associations_plist()` only inserts
  `public.mime-type` inside the `exported_type`-present branch). `identifier:
  "org.apache.parquet"` is Atrium's own declaration, not a claim that Apple
  or Apache registered this UTI — there is no existing one to reference,
  which is what makes this the `exportedType` case rather than the
  `contentTypes` one.
- Dedup reason, corrected: not a Linux `.desktop` conflict (Linux ignores
  `ext` entirely) but a Windows ProgID collision (NSIS maps each `ext` to
  one ProgID; two associations claiming `.csv` conflict) and a macOS
  `CFBundleDocumentTypes` conflict (two document-type entries claiming the
  same extension with different `CFBundleTypeRole` — `Editor` vs the new
  `Viewer` — is undefined/inconsistent behavior for Launch Services).

### 2. Linux: ship a `shared-mime-info` package for Parquet

`.deb` is a real, CI-built target (`.github/workflows/ci.yml` builds
`deb,appimage`), so this is worth doing rather than disclaiming.

Add `src-tauri/linux/atrium-mime.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/vnd.apache.parquet">
    <comment>Apache Parquet document</comment>
    <glob pattern="*.parquet"/>
    <magic priority="50">
      <match type="string" value="PAR1" offset="0"/>
    </magic>
  </mime-type>
</mime-info>
```

(Parquet files open and close with a 4-byte `PAR1` magic; only the header
copy is checkable with a fixed-offset match, which is sufficient — the
`glob` alone already carries most of the practical matching weight, same as
every other format in `shared-mime-info`.)

Wire it into `bundle.linux.deb` in `tauri.conf.json`:

```json
"linux": {
  "deb": {
    "desktopTemplate": "linux/main.desktop.hbs",
    "files": {
      "/usr/share/mime/packages/atrium.xml": "linux/atrium-mime.xml"
    }
  }
}
```

`deb.files` is a real `DebConfig` field (`config.rs:338-381`); the map's
key/value direction is destination-path → source-path (Tauri's own
documented `DebConfig.files` example uses this direction, and the source
path resolves relative to `src-tauri/`, matching the existing
`desktopTemplate: "linux/main.desktop.hbs"` convention already in this
block) — confirmed by building a real `.deb` and inspecting its contents
(see "Testing").

No `postInstallScript` is added. `shared-mime-info` already registers a
dpkg trigger on `/usr/share/mime/packages` (`/var/lib/dpkg/triggers/File`),
so dpkg runs `update-mime-database` after any package — including this
one — drops a file there; a hand-written postinst calling it again would
be a redundant no-op on every system that can actually benefit from it,
and a silent no-op (behind its own `command -v` guard) on any system
without `shared-mime-info` installed. The smaller change that still fully
works is to rely on the trigger.

**AppImage gets no fix and none is possible**: it has no install step, so
there's nowhere to run `update-mime-database`. Parquet default-open will
not work from an AppImage build; this is a disclosed, permanent gap for
that packaging format, not an oversight. RPM is untouched — this repo
doesn't build RPM packages today (CI builds `deb,appimage` only), so
`RpmConfig`'s equivalent fields are out of scope.

## Scope boundaries

- **`.tsv` is not touched.** Same `DataPane` handling as CSV/Parquet, but
  it isn't in any `fileAssociations` entry today either, and issue #403
  asks for parquet and csv specifically. A natural, small follow-up.
- **No in-app setting is added** — see "Problem" above.
- **No README change** — `README.md:19` already describes the data grid
  and says nothing about file associations for any format.

## Testing

- `npm run check`, `npm test`, `cargo fmt --check`, `cargo clippy -D
  warnings`, `cargo test` all stay green — no Rust or TypeScript source
  changes, only bundler-consumed config and a MIME-type declaration.
- Hand-check the two new JSON entries against `FileAssociation`'s schema
  (`required: ["ext"]`; the struct also carries `#[serde(deny_unknown_fields)]`
  in `tauri-utils` 2.9.3, so a mistyped key is a hard parse error at config
  load, not a silent drop — correcting revision 1's claim that JSON
  Schema's `additionalProperties: false` was the relevant mechanism; both
  describe the same "typo is rejected, not ignored" outcome, but the actual
  enforcement for a config the Tauri CLI parses at build time is the serde
  attribute).
- **Build a real Linux `.deb`** (`npm run tauri build -- --bundles deb` —
  this repo's Tauri CLI is the npm one, not a `cargo tauri` subcommand) and
  inspect it: confirm `linux/atrium-mime.xml` lands at
  `/usr/share/mime/packages/atrium.xml` inside the package, and confirm the
  generated `.desktop` file's `MimeType=` line includes both `text/csv` and
  `application/vnd.apache.parquet`. This is the closest this repo can get
  to an automated check for OS-level registration, and it's newly feasible
  to attempt here since this environment has `dpkg-deb` and `webkit2gtk-4.1`
  (unlike the "Additional testing required" gap PR #398 disclosed for
  double-click confirmation on installed packages, which still needs a
  human with real hardware/VMs for each OS).
- **Extend `tests/e2e/specs/launchOpen.e2e.js`** with a second case: add
  `tests/e2e/fixtures/launch-open.csv`, spawn the built binary with that
  path the same way the existing Markdown case does, and assert the
  resulting tab shows `.data-pane` (`DataPane.svelte:116`) instead of
  `.cm-content`. This is the one piece of the routing path
  ("`modeForPath`/`isDataPath`/`DataPane` need no code change") that's
  currently asserted only by reasoning, not by a running test, and it's
  cheap to close given the existing spec already does 90% of the work.
- Still **not verifiable in CI or locally**: whether Atrium actually shows
  up in Windows' or macOS's native "Open With"/default-apps picker after a
  full installer run — that remains a human check against a produced
  installer, same limitation PR #398 disclosed.

## Open Questions

None — round 1's one open question (ship the Linux MIME package vs. scope
it out) is resolved by adopting the recommended option; see "Changes from
revision 1".

---

## Changes from revision 1

- **Must-fix 1 adopted**: added `src-tauri/linux/atrium-mime.xml` +
  `deb.files` wiring so Linux Parquet default-open actually functions on
  the `.deb` target, with the AppImage gap now explicitly disclosed rather
  than implied.
- **Must-fix 2 adopted**: added `contentTypes` to the CSV entry and
  `exportedType` to the Parquet entry; corrected the Problem section's
  wrong claim that Tauri synthesizes a UTI from `ext`+`mimeType`, and its
  wrong claim that PR #398 already populated `UTExportedTypeDeclarations`.
- Fixed the "Source Code" entry's line citation (`41-60`, not `20-33`).
- Corrected the dedup rationale to the real Windows/macOS reasons (Linux
  never reads `ext`, so a `.desktop` conflict was never the actual risk).
- Corrected the "Testing" section's schema-vs-silent-drop reasoning — and,
  on independently re-checking the vendored source rather than taking
  either the original plan's or round 1's claim at face value,
  `FileAssociation` **does** carry `#[serde(deny_unknown_fields)]` in
  `tauri-utils` 2.9.3 (`config.rs:1184`); round 1's claim that it doesn't
  was itself incorrect. The corrected text above reflects what's actually
  in the source.
- Adopted the e2e-fixture nice-to-have (a `.csv` launch-open case) since it's
  cheap and closes the one routing claim this plan makes without a test.
- Not adopted: nothing — every finding was either a must-fix (both
  adopted) or a nice-to-have judged worth taking as well.

## Changes from revision 2 (round 2: approve, six nice-to-haves)

Round 2 review: `docs/analysis/2026-08-10-issue-403-plan-review-round-2.md`
(verdict: approve). All six nice-to-haves folded in or resolved during
implementation:

- **Dropped `postInstallScript`.** Round 2 proved it's a strict no-op:
  `shared-mime-info` already registers a dpkg trigger on
  `/usr/share/mime/packages`, so dpkg runs `update-mime-database` after
  this package's `deb.files` entry lands there regardless. Kept only
  `deb.files`; see "Change" §2 above for the reasoning.
- **`deb.files` direction confirmed correct without needing to guess**:
  destination path as key, source path (relative to `src-tauri/`) as
  value — matches the snippet already in this plan. Still verified by an
  actual `.deb` build (see "Testing").
- **Corrected the build command**: `cargo tauri` isn't installed in this
  environment; this repo's Tauri CLI is the npm one
  (`npm run tauri build -- --bundles deb`).
- **Fixed two more citation slips**: `deny_unknown_fields` is
  `config.rs:1184` (not 1183, corrected above); `DebConfig` spans
  `config.rs:338-381` (not 338-372).
- IANA registration date (2024-02-14) left as-is — the type string is
  independently correct and nothing depends on the date.
