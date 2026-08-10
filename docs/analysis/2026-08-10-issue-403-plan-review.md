# Review: implementation plan for issue #403 (CSV/Parquet default-open)

- **Plan under review:** `docs/analysis/2026-08-10-issue-403-parquet-csv-default-open-plan.md`
- **Issue:** greerviau/atrium#403, "allow configuring parquet and csv to default open with atrium" (body empty; the title is the whole requirement)
- **Code reviewed at:** branch `fix/parquet-csv-default-open`, `HEAD` = `20e93fa`, confirmed to contain `origin/main` (`git-freshness-check.sh` → `fresh:HEAD already contains origin/main`, `path-same:src-tauri/tauri.conf.json`)
- **Toolchain the claims were checked against:** `tauri` 2.11.5 (`src-tauri/Cargo.lock:4152`), config schema from `tauri-utils` 2.9.3

## Verdict

**Request changes.** Two must-fix items. The approach — extend `bundle.fileAssociations` rather than invent an in-app "set as default" setting — is the right shape and correctly reuses the #362/PR #398 infrastructure. But as written the change does not deliver the Parquet half of the issue on Linux, and its stated reason for omitting a macOS UTI declaration is factually wrong in a way that changes what the JSON should contain.

The routing half of the plan's claims checked out completely; see "Verified as claimed" below.

---

## Must-fix

### 1. On Linux, the Parquet association registers a MIME type the system has never heard of, so it matches no file

`src-tauri/linux/main.desktop.hbs` emits `MimeType={{mime_type}}` verbatim, and Tauri's Linux bundler builds that value only from each association's `mimeType` — the `ext` array is not used on Linux at all. A `.desktop` `MimeType=` line only ever matches if the desktop environment's own MIME resolution (shared-mime-info) independently classifies the file as that type.

There is no Parquet entry anywhere in shared-mime-info:

```
$ grep -in "parquet\|PAR1" /usr/share/mime/packages/*.xml /usr/share/mime/globs /usr/share/mime/globs2 \
    /usr/share/mime/magic /usr/share/mime/aliases /usr/share/mime/subclasses
(no matches)

$ xdg-mime query filetype real.parquet     # 4-byte PAR1 header + binary body
application/octet-stream
```

So after this change a real `.parquet` file still resolves to `application/octet-stream`, while Atrium's desktop entry advertises `application/vnd.apache.parquet`. The two never meet. Concretely: Atrium does not appear in the file manager's Recommended/"Open With" list for a `.parquet` file, and the only way a user can pick it is via "Other Applications" — which, if they then tick "set as default", binds Atrium as the default handler for `application/vnd.apache.parquet` (still matching nothing) or for `application/octet-stream` (every unrecognized binary file on the system). Neither is the requested feature.

The IANA registration the plan cites is real and the right type string to use; it just is not sufficient on its own, because shared-mime-info is a separate database that must be told about it.

The fix is to ship a shared-mime-info package with the Linux bundle so the type exists. Tauri 2.11 supports both halves of this in config (`tauri-utils` `DebConfig`: `files: HashMap<PathBuf, PathBuf>` and `post_install_script`; `RpmConfig` has the same two fields):

- a `linux/atrium-mime.xml` declaring `application/vnd.apache.parquet` with `<glob pattern="*.parquet"/>` and `<magic><match type="string" value="PAR1" offset="0"/></magic>` (Parquet's magic bytes are `PAR1` at offset 0 and at EOF-4, so the glob plus the header match is the standard shape),
- `bundle.linux.deb.files` mapping it to `/usr/share/mime/packages/atrium.xml`,
- `bundle.linux.deb.postInstallScript` running `update-mime-database /usr/share/mime`.

CI builds `deb,appimage` on Linux (`.github/workflows/ci.yml:32`), so `deb` is a shipped target this actually fixes. AppImage has no install step and cannot register a system MIME type; if that stays unsupported, the plan should say so explicitly rather than leave it implied — an undisclosed platform gap in a "purely mechanical registration" plan is the thing most likely to be discovered by a user rather than by us.

If shipping the MIME package is judged out of scope, that is a defensible call, but then the plan must say plainly that Linux Parquet default-open does not work and why. It cannot claim the change delivers the feature on Linux.

**CSV on Linux is fine** and needs none of this: `text/csv` is a real shared-mime-info type (`/usr/share/mime/packages/freedesktop.org.xml:35391`), `xdg-mime query filetype t.csv` → `text/csv`, and it is registered as a subclass of `text/plain` (`/usr/share/mime/subclasses:338`).

### 2. The stated reason for omitting `exportedType` is false; Tauri never synthesizes a UTI, and as written both new entries emit no macOS content type at all

The plan says: *"Tauri's macOS bundler is already relied on to synthesize the exported UTI from `ext`+`mimeType`."* It does not. From `tauri-utils` 2.9.3 `src/config.rs`, `file_associations_plist()` builds `UTExportedTypeDeclarations` from

```rust
association.exported_type.as_ref().map(|exported_type| { ... })
```

— a `filter_map` over `exported_type`. With no `exportedType` set, no declaration is emitted, and since `public.mime-type` is inserted *inside* that same closure, the `mimeType` value never reaches the macOS `Info.plist` at all. Today's built app therefore has **no** `UTExportedTypeDeclarations` key whatsoever (no existing entry sets `exportedType`), which also makes the Problem section's description of PR #398 as registering "macOS `CFBundleDocumentTypes`/`UTExportedTypeDeclarations`" wrong on the second half.

What each association *does* get on macOS is a `CFBundleDocumentTypes` dict with `CFBundleTypeExtensions` (from `ext`), `CFBundleTypeName`, `CFBundleTypeRole`, `LSHandlerRank`, and `LSItemContentTypes` — but the last one only `if !content_types.is_empty()`, where `content_types` comes from `infer_content_types()`. That function consults two hardcoded tables, `extension_to_uti` (`config.rs:1415`) and `mime_type_to_uti` (`config.rs:1449`). Neither contains `csv`, `parquet`, `text/csv`, or `application/vnd.apache.parquet`; `mime_type_to_uti` matches `text/plain` exactly and has no `text/*` fallback arm.

Consequence of the plan as written: **both** new entries emit `LSItemContentTypes`-free document types, identified to Launch Services only by the deprecated `CFBundleTypeExtensions`. For CSV this is also a step down from today, where `csv` rides in the "Source Code" entry whose `mimeType: "text/plain"` does resolve to `public.plain-text`.

Two concrete corrections, both cheap:

- CSV: add `"contentTypes": ["public.comma-separated-values-text"]` — the system UTI already exists, so no exported type is needed. (`contentTypes` maps to `LSItemContentTypes`; the "Text Document" entry at `tauri.conf.json:69-83` already uses this field, so it is an established pattern in this file.)
- Parquet: add `"exportedType": { "identifier": "org.apache.parquet", "conformsTo": ["public.data"] }` — `.parquet` has no system UTI, which is exactly the "custom file type" case Tauri documents `exportedType` for, and it is the only way the `application/vnd.apache.parquet` string reaches the plist.

Confidence note, stated honestly: modern macOS Launch Services does still honor `CFBundleTypeExtensions`-only document types in many cases, so I am not claiming the plan's version is guaranteed to fail on macOS (moderate confidence it degrades, high confidence it is less reliable than a declared type). What I am claiming with high confidence is that the plan's *justification* is false, and that a plan may not ship a decision resting on a mechanism that does not exist. Verify the built `Info.plist` rather than reasoning about it further.

---

## Nice-to-have

3. **Wrong line citation.** The plan cites the "Source Code" entry as `tauri.conf.json:20-33`; it is at `41-60` (`csv` specifically at line 47). Lines 20-33 are the window/CSP config. This will misdirect whoever implements it.

4. **The dedup rationale is wrong, though the dedup itself is right.** The plan justifies removing `"csv"` from "Source Code" as avoiding *"a duplicate/conflicting `MimeType=` line in the generated `.desktop` file on Linux."* Linux never reads `ext`; the `.desktop` `MimeType=` is assembled from `mimeType` values only, so listing `csv` in two `ext` arrays has zero Linux effect. The real reasons to dedup are Windows (NSIS registers each `ext` to a ProgID, so two associations claiming `.csv` conflict) and macOS (two `CFBundleDocumentTypes` entries claiming the same extension with different `CFBundleTypeRole` values — `Editor` vs the new `Viewer`). Keep the change, fix the reason.

5. **The schema reasoning in "Testing" is backwards.** `"additionalProperties": false` in `config.schema.json` means a schema validator *rejects* an unknown key — it is not the reason a typo would be "silently dropped." The silent-drop behavior comes from the Rust side: `FileAssociation` has no `#[serde(deny_unknown_fields)]` (unlike `ExportedFileAssociation`, which does). The advice to hand-check the keys is good; the stated reason should be the serde one.

6. **The one real regression test available here is left on the table.** The plan says there is "no WebDriver or unit harness" for this. True for OS-level registration, but PR #398 shipped `tests/e2e/specs/launchOpen.e2e.js`, which spawns the built binary with a file-path argument and asserts the file opens in the running instance. Extending it with a `.csv` fixture asserting the DataPane grid renders (rather than `.cm-content`) would lock in the routing half — the half the plan asserts is already correct and changes nothing to preserve. Cheap, and it is the only automated coverage this feature can have.

7. **Scope calls are sound.** Leaving `.tsv` out, adding no in-app setting, and making no README change are all correct and correctly argued. I verified the README claim: `README.md:19` describes the data grid and the file says nothing about file associations for any format. I also verified there is no default-app precedent in `src/lib/settings/settingsRegistry.ts`.

---

## Verified as claimed

Stated so the developer does not re-derive these:

- `role: "Viewer"` and `rank: "Alternate"` are both valid (`BundleTypeRole` at `config.rs:1103`, `HandlerRank` at `config.rs:1134`). `Viewer` is genuinely the accurate value and the argument for diverging from the surrounding `Editor` entries holds.
- `.parquet` really is absent from every `fileAssociations` entry; `csv` really is only in the "Source Code" bucket under `mimeType: "text/plain"`, `role: "Editor"`.
- `DataPane` really is read-only: `src/lib/editor/DataPane.svelte` issues exactly one backend call, `dataQuery`, and there is no write/save command for data files.
- **"Nothing on the frontend or in `launch_open.rs` needs to change" holds, and I traced it end to end** — the plan asserted this without evidence, and it is correct. `App.svelte:1128-1141` grants the OS-supplied path via `fsGrantExternalFile` then calls the generic `openFileReportingErrors`, which routes by `modeForPath` (`src/lib/editor/codeExtensions.ts:13-19`, `DATA_EXTENSIONS = {csv, tsv, parquet}` at line 10) into `DataPane`. `DataPane`'s `dataQuery` reaches `LocalWorkspace::query_data` (`src-tauri/src/workspace/local.rs:1194-1210`), which resolves through `resolve_read_target` (`local.rs:704-709`), which consults `external_grants.resolve_granted` before falling back to the workspace root. So a double-clicked CSV/Parquet living outside any workspace is readable through the same grant the launch path establishes. No code change needed.

## Open Questions

```wingman-questions
{
  "questions": [
    {
      "id": "linux-parquet",
      "type": "choice",
      "question": "How should the plan handle Parquet on Linux, where no shared-mime-info type for it exists?",
      "options": [
        { "label": "Ship a MIME package", "recommended": true,
          "detail": "Add linux/atrium-mime.xml plus deb.files and deb.postInstallScript running update-mime-database. This is what actually makes .parquet default-open work on the shipped deb target; AppImage remains unsupported and is disclosed." },
        { "label": "Scope Linux Parquet out",
          "detail": "Keep the JSON-only change and state plainly in the plan that Linux Parquet default-open does not work, deferring it to a follow-up issue. Delivers the CSV half and the macOS/Windows Parquet halves only." }
      ],
      "free_text": true
    }
  ]
}
```
