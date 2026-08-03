# macOS FSEvents rename and delete findings

## Scope

- The investigation checks the dependency and runtime behavior reported by issue #313. Citation: [Atrium issue #313](https://github.com/greerviau/atrium/issues/313). Confidence: high.
- The physical reproduction environment runs macOS 26.5.2. Citation: `sw_vers` output recorded in the 2026-08-03 issue #313 investigation. Confidence: high.
- Assumption: Atrium must preserve rename and delete semantics for both preexisting files and files created shortly before the external mutation. Confidence: high.

## Versions

- Atrium pins `notify` 6.1.1 and `notify-debouncer-full` 0.3.2. Citation: [`src-tauri/Cargo.lock`](../../src-tauri/Cargo.lock#L2547-L2578). Confidence: high.

## Findings

- `notify` 6.1.1 translates each FSEvents `ITEM_RENAMED` flag into `Modify(Name(Any))` and states that FSEvents does not associate the old and new rename sides. Citation: [`notify` 6.1.1 `fsevent.rs`, lines 190-195](https://github.com/notify-rs/notify/blob/notify-6.1.1/notify/src/fsevent.rs#L190-L195). Confidence: high.
- `notify-debouncer-full` 0.3.2 can correlate rename halves by file identity, but its API requires callers to register the watched root separately with `cache().add_root(...)`. Citation: [`notify-debouncer-full` 0.3.2 crate documentation, lines 43-50](https://github.com/notify-rs/notify/blob/debouncer-full-0.3.2/notify-debouncer-full/src/lib.rs#L43-L50). Confidence: high.
- `FileIdMap::add_root` recursively indexes existing children and maintains those identities as paths change. Citation: [`notify-debouncer-full` 0.3.2 `cache.rs`, lines 51-62](https://github.com/notify-rs/notify/blob/debouncer-full-0.3.2/notify-debouncer-full/src/cache.rs#L51-L62). Confidence: high.
- Before this fix, Atrium registered only the OS watcher, so files that predated the watcher were absent from the debouncer's identity cache. Citation: parent commit `fbf62e7`, `src-tauri/src/fs_watch.rs`, watch registration immediately before `Ok(debouncer)`. Confidence: high.
- On the physical Mac, the original fresh-file rename reproduction emitted only `Create` for the destination, and the original fresh-file deletion reproduction emitted only `Modify` for the deleted path. Citation: `fs_watch::tests::a_same_directory_rename_arrives_as_one_paired_rename_event` and `fs_watch::tests::a_delete_still_emits_a_plain_remove_with_no_from_path`, run against parent commit behavior on 2026-08-03. Confidence: high.
- Upstream reports that FSEvents can merge flags for a file for roughly 30 seconds, and that waiting 35 seconds normalizes rename events. Citation: [`notify` issue #181 comment](https://github.com/notify-rs/notify/issues/181#issuecomment-463623803) and [35-second reproduction](https://github.com/notify-rs/notify/issues/181#issuecomment-463620571). Confidence: low.
- The physical-Mac long-lived-file rename passed only after the preexisting file identity was indexed; without the index it emitted unpaired `Create` events for both paths. Citation: `fs_watch::tests::a_long_lived_preexisting_file_rename_is_correlated` and the issue #313 reproduction sequence run on 2026-08-03. Confidence: high.
- The physical-Mac long-lived-file deletion already arrived as `Remove`, while a fresh deletion arrived as `Modify`; therefore classifying a missing, previously indexed path from current filesystem state is required to cover the fresh-file case. Citation: `fs_watch::tests::a_delete_still_emits_a_plain_remove_with_no_from_path`, run with fresh and 35-second-old fixtures on 2026-08-03. Confidence: high.
- `notify` 8.2.0 retains the same basic `ITEM_RENAMED` to `Modify(Name(Any))` translation, so upgrading to the latest stable release does not eliminate the FSEvents information gap. Citation: [`notify` 8.2.0 `fsevent.rs`, lines 192-197](https://github.com/notify-rs/notify/blob/notify-8.2.0/notify/src/fsevent.rs#L192-L197). Confidence: high.

## Conclusion

- Atrium must maintain its own file-identity index at the watcher boundary, use it to infer a unique missing source when FSEvents leaves only a destination event, and reinterpret an event for a missing indexed path as removal. This follows from the pinned backend's information loss and the physical-Mac reproductions above. Citations: findings 1-8. Confidence: high.
- A dependency upgrade alone is not a complete fix. Citation: finding 8. Confidence: high.
