# Review round 2 (final): implementation plan for issue #403 (CSV/Parquet default-open)

- **Plan under review:** `docs/analysis/2026-08-10-issue-403-parquet-csv-default-open-plan.md`, revision 2
- **Round 1:** `docs/analysis/2026-08-10-issue-403-plan-review.md` (verdict: request changes, two must-fix items)
- **Issue:** greerviau/atrium#403, "allow configuring parquet and csv to default open with atrium"
- **Code reviewed at:** branch `fix/parquet-csv-default-open`, `HEAD` = `20e93fa`; freshness confirmed (`fresh:HEAD already contains origin/main`, `path-same:src-tauri/tauri.conf.json`)
- **Sources checked against:** vendored `tauri-utils` 2.9.3 (`~/.cargo/registry/src/index.crates.io-*/tauri-utils-2.9.3/src/config.rs`), the shipped config schema (`@tauri-apps/cli/config.schema.json`), and this machine's live `shared-mime-info` database

## Verdict

**Approve.** Both round-1 must-fix items are addressed correctly, and I re-derived the
mechanisms from the vendored source myself rather than accepting the revision's summary of
them. Revision 2 is also right where it contradicts round 1: `FileAssociation` **does**
carry `#[serde(deny_unknown_fields)]`, and round 1's claim to the contrary was wrong.

The remaining items below are all nice-to-have. None of them blocks implementation, and
none is worth another review round; fold them in while implementing or ignore them with a
one-line reason.

---

## Must-fix items from round 1: verification

### 1. Linux Parquet MIME registration — resolved, and empirically proven to work

The plan now ships `src-tauri/linux/atrium-mime.xml`, wires it via `bundle.linux.deb.files`
and `bundle.linux.deb.postInstallScript`, and discloses the AppImage gap explicitly.

Checked, not assumed:

- Both config fields are real and correctly named. `DebConfig` (`config.rs:338-381`) carries
  `files: HashMap<PathBuf, PathBuf>` and `post_install_script` (serde-renamed
  `postInstallScript`), and both appear in the shipped `config.schema.json`.
- The premise still holds on this machine: zero `parquet`/`PAR1` hits across
  `/usr/share/mime/{packages/*.xml,globs,globs2,magic,aliases,subclasses}`, and a real
  `PAR1`-header file resolves to `application/octet-stream`. `text/csv` is present (`globs`)
  and a `.csv` file resolves to `text/csv`.
- **The proposed XML actually works.** I installed the plan's exact XML into an isolated
  `XDG_DATA_HOME`, ran `update-mime-database`, and queried:

  ```
  $ update-mime-database $S/share/mime
  $ XDG_DATA_HOME=$S/share xdg-mime query filetype t.parquet
  application/vnd.apache.parquet
  $ XDG_DATA_HOME=$S/share xdg-mime query filetype noext_test   # PAR1 header, no extension
  application/vnd.apache.parquet
  ```

  So both the glob and the magic rule match, and the type the `.desktop` file advertises is
  the type a real `.parquet` file will resolve to. That is exactly the gap round 1 identified,
  closed. (Nothing was written to the real MIME database; the check ran entirely in a scratch
  `XDG_DATA_HOME`.)

The AppImage disclosure is accurate: an AppImage has no install step, so no
`update-mime-database` run, so no host-level type registration.

### 2. macOS content types — resolved, and the corrected reasoning matches the source

The plan now adds `contentTypes` to CSV and `exportedType` to Parquet. Traced through
`tauri-utils` 2.9.3:

- `FileAssociation::infer_content_types()` (`config.rs:1265`) short-circuits when
  `exported_type` is set and returns **only** the exported identifier. So the Parquet entry
  yields `LSItemContentTypes = ["org.apache.parquet"]`.
- With no `exported_type`, explicit `content_types` are used as-is, plus anything
  `extension_to_uti` (`config.rs:1415`) or `mime_type_to_uti` (`config.rs:1449`) can infer.
  Neither table contains `csv`, `parquet`, `text/csv`, or `application/vnd.apache.parquet`,
  and `mime_type_to_uti` matches `text/plain` exactly with no `text/*` fallback arm — so the
  CSV entry yields exactly `LSItemContentTypes = ["public.comma-separated-values-text"]`,
  and without the fix it would have yielded nothing. The regression round 1 flagged (CSV
  losing `public.plain-text` when it leaves the "Source Code" bucket) is therefore prevented.
- `file_associations_plist()` (`config.rs:1302`) builds `UTExportedTypeDeclarations` from a
  `filter_map` over `exported_type`, and inserts `public.mime-type` into
  `UTTypeTagSpecification` **inside** that closure. The plan's claim that `exportedType` is
  the only mechanism that gets `application/vnd.apache.parquet` into the plist is correct, as
  is its correction that PR #398 never populated `UTExportedTypeDeclarations`.
- `public.comma-separated-values-text` is the real system UTI for CSV (conforms to
  `public.delimited-values-text`), so `contentTypes` rather than `exportedType` is the right
  mechanism there. High confidence.

### Round 1's own error, correctly overturned

Revision 2 states that `FileAssociation` carries `#[serde(deny_unknown_fields)]` and that
round 1 was wrong to say it does not. Confirmed: `config.rs:1184`, immediately above
`pub struct FileAssociation` at 1185. A mistyped key in a new association is a hard config
parse error, not a silent drop. The revised "Testing" text is the accurate version.

---

## Nice-to-have

1. **`deb.files` direction is knowable now; the plan need not defer it.** The plan says the
   key/value direction will be settled during implementation by building a `.deb`. Keeping
   that build check is right, but the direction is already documented: Tauri's own
   `DebConfig.files` example is `{"/usr/share/README.md": "../README.md"}` — absolute
   destination path as key, source path as value, source resolved relative to `src-tauri/`
   the same way the existing `desktopTemplate: "linux/main.desktop.hbs"` is. That matches the
   plan's snippet exactly, so the snippet is very likely already correct (moderate-high
   confidence; the shipped `config.schema.json` documents only "The files to include on the
   package" and states no direction, which is why the build check stays worth running).

2. **The `postInstallScript` is a no-op on every system that can benefit from it.**
   `shared-mime-info` registers a dpkg trigger on the very directory the plan installs into:

   ```
   $ grep -n "usr/share/mime/packages" /var/lib/dpkg/triggers/File
   13:/usr/share/mime/packages shared-mime-info/noawait
   ```

   So dpkg already runs `update-mime-database` after any package drops a file there. And when
   `shared-mime-info` is absent, `update-mime-database` is absent too, so the script's own
   `command -v` guard makes it do nothing. Keeping the script is defensible belt-and-braces
   (it still fires under `dpkg --no-triggers`), but the plan currently presents it as the
   thing that makes registration work. Either drop it as redundant — the smaller change that
   still fully works — or keep it with a one-line note that the dpkg trigger is the primary
   mechanism, so a PR reviewer does not mistake it for load-bearing.

3. **Say explicitly that the postinst must be committed executable.** Debian requires
   maintainer scripts at mode 0755, and the bundler copies the file rather than synthesizing
   it, so the mode in git is the mode in the package. The plan's testing step checks this
   after the fact ("confirm the postinst script is present and executable"); making it an
   implementation instruction (`chmod +x` before committing) avoids one predictable rebuild.

4. **`cargo tauri` is not installed in this environment.** The testing section says a local
   `cargo tauri build --bundles deb` is feasible here. `dpkg-deb` and `webkit2gtk-4.1` are
   both present as claimed, but `cargo tauri --version` fails with `error: no such command:
   tauri`. This repo's Tauri CLI is the npm one (`@tauri-apps/cli` in `devDependencies`,
   `"tauri": "tauri"` script), so the command is `npm run tauri build -- --bundles deb`. The
   substance of the test step is unaffected; only the invocation is wrong.

5. **Two citation slips, both trivial.** `deny_unknown_fields` is at `config.rs:1184`, not
   1183 (1183 is the `cfg_attr` line above it); `DebConfig` spans `338-381`, not `338-372`.
   Every other citation in revision 2 checked out exactly: `infer_content_types` 1265,
   `file_associations_plist` 1302, `extension_to_uti` 1415, `mime_type_to_uti` 1449, and in
   `tauri.conf.json` the `fileAssociations` array 32-84, the "Source Code" entry 41-60 with
   `csv` at 47, the "Text Document" `contentTypes` at 76-82.

6. **`application/vnd.apache.parquet` — right string, unverified date.** The type string is
   the one Apache uses and is the correct choice here; I did not independently confirm the
   "2024-02-14" IANA registration date the plan cites. Low-stakes: nothing in the change
   depends on the date. Drop it or leave it.

---

## Also verified in this round

- The e2e extension the plan proposes is sound. `tests/e2e/specs/launchOpen.e2e.js` spawns the
  built binary with a fixture path and waits on `.cm-content`; `DataPane.svelte:116` renders
  `<div class="data-pane">` unconditionally (outside every `{#if}`), so a `.data-pane`
  assertion for a `.csv` fixture will not flake on query success or on the grid being empty.
  `tests/e2e/fixtures/` is where `launch-open.md` already lives.
- The dedup rationale as corrected in revision 2 is right: `src-tauri/linux/main.desktop.hbs`
  emits `MimeType={{mime_type}}` only, so `ext` has no Linux effect at all, and the real
  reasons to pull `csv` out of the "Source Code" entry are the Windows ProgID collision and
  the conflicting macOS `CFBundleTypeRole`.
- The existing `bundle.linux.deb` block (`tauri.conf.json:92-95`) contains only
  `desktopTemplate`, and the plan's replacement snippet preserves it. No existing config is
  dropped.
- Scope calls (no `.tsv`, no in-app setting, no README change) are unchanged from revision 1
  and were verified in round 1.

## Open questions

None. Round 1's single open question (ship the Linux MIME package, or scope Linux Parquet
out) was answered by adopting the recommended option, and the adopted version demonstrably
works.
