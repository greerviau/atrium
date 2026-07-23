use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::ipc::Channel;

/// Cap on buffered output kept before the frontend calls `pty_subscribe`.
/// Generous enough to hold a shell's startup banner/prompt without growing
/// unbounded if a subscriber never shows up.
const BUFFER_CAP: usize = 64 * 1024;

/// How often the shared poller re-checks every live session's cwd and
/// foreground process. Cheap enough per tick (a handful of sessions, each a
/// couple of targeted `sysinfo` refreshes) to run for the app's whole
/// lifetime, and fast enough that a tab title update never feels laggy.
const TITLE_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// The last `(cwd, program)` pair reported for a session, kept so a poll
/// tick that finds nothing has actually changed can skip sending an event.
type TitleSnapshot = (String, Option<String>);

/// One session's poll-tick inputs: its id, shell pid, event channel,
/// last-reported title, and last-seen foreign foreground pid, snapshotted
/// together while the sessions map is briefly locked (see
/// `poll_titles_loop`).
type SessionPollSnapshot = (
    String,
    u32,
    Arc<Mutex<Shared>>,
    Arc<Mutex<Option<TitleSnapshot>>>,
    Arc<Mutex<Option<u32>>>,
);

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PtyEvent {
    #[serde(rename = "data")]
    Data { data: String },
    #[serde(rename = "exit")]
    Exit { code: Option<i32> },
    #[serde(rename = "title")]
    Title {
        cwd: String,
        program: Option<String>,
    },
}

struct Shared {
    channel: Option<Channel<PtyEvent>>,
    buffer: Vec<u8>,
    exit_code: Option<Option<i32>>,
}

impl Shared {
    fn push_data(&mut self, chunk: &[u8]) {
        match &self.channel {
            Some(channel) => {
                let _ = channel.send(PtyEvent::Data {
                    data: STANDARD.encode(chunk),
                });
            }
            None => {
                self.buffer.extend_from_slice(chunk);
                if self.buffer.len() > BUFFER_CAP {
                    let overflow = self.buffer.len() - BUFFER_CAP;
                    self.buffer.drain(0..overflow);
                }
            }
        }
    }

    fn push_exit(&mut self, code: Option<i32>) {
        match &self.channel {
            Some(channel) => {
                let _ = channel.send(PtyEvent::Exit { code });
            }
            None => {
                self.exit_code = Some(code);
            }
        }
    }

    /// Unlike `push_data`/`push_exit`, a `Title` event with no subscriber
    /// attached yet is simply dropped rather than buffered: the frontend
    /// already seeds the tab's initial title synchronously from the spawn
    /// cwd, so a poll tick firing before `pty_subscribe` runs would only be
    /// reporting a state the frontend already has.
    fn push_title(&self, cwd: String, program: Option<String>) {
        if let Some(channel) = &self.channel {
            let _ = channel.send(PtyEvent::Title { cwd, program });
        }
    }
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
    /// The shell's own pid, captured once at spawn. `None` on a pty backend
    /// that can't report it, in which case the title poller simply skips
    /// this session.
    shell_pid: Option<u32>,
    last_title: Arc<Mutex<Option<TitleSnapshot>>>,
    /// The previous tick's foreign foreground pid (if any), kept so the
    /// tick that observes it exit still names it in the `sysinfo` refresh —
    /// see `poll_one`.
    last_foreign_pid: Arc<Mutex<Option<u32>>>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    /// Constructs a manager and starts its single shared title-polling
    /// thread. Replaces the previous `#[derive(Default)]` because the
    /// poller needs to be started exactly once, alongside the sessions map
    /// it watches — a session added to the map later is simply picked up on
    /// the poller's next tick, and one removed via `kill` is simply absent
    /// from it, with no separate registration/cancellation needed.
    pub fn new() -> Self {
        let sessions: Arc<Mutex<HashMap<String, PtySession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let poller_sessions = sessions.clone();
        std::thread::spawn(move || Self::poll_titles_loop(poller_sessions));
        Self { sessions }
    }

    pub fn spawn(&self, cwd: String, cols: u16, rows: u16) -> Result<String, AppError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("failed to open pty: {e}")))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Other(format!("failed to spawn shell: {e}")))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Other(format!("failed to clone pty reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Other(format!("failed to take pty writer: {e}")))?;

        let terminal_id = uuid::Uuid::new_v4().to_string();
        let shared = Arc::new(Mutex::new(Shared {
            channel: None,
            buffer: Vec::new(),
            exit_code: None,
        }));

        // The reader thread starts immediately (not on `pty_subscribe`) and
        // buffers into `shared` until a channel is attached, so fast output
        // during shell startup isn't lost if the frontend subscribes a beat
        // later than `pty_spawn` returns.
        let reader_shared = shared.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        reader_shared.lock().unwrap().push_exit(None);
                        break;
                    }
                    Ok(n) => {
                        reader_shared.lock().unwrap().push_data(&buf[..n]);
                    }
                    Err(_) => {
                        reader_shared.lock().unwrap().push_exit(None);
                        break;
                    }
                }
            }
        });

        let shell_pid = child.process_id();

        self.sessions.lock().unwrap().insert(
            terminal_id.clone(),
            PtySession {
                writer,
                master: pair.master,
                child,
                shared,
                shell_pid,
                last_title: Arc::new(Mutex::new(None)),
                last_foreign_pid: Arc::new(Mutex::new(None)),
            },
        );

        Ok(terminal_id)
    }

    pub fn subscribe(&self, terminal_id: &str, channel: Channel<PtyEvent>) -> Result<(), AppError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| AppError::NotFound(format!("unknown terminal: {terminal_id}")))?;
        // A poll tick landing between `spawn` and this call would have found
        // `push_title` dropping its event with nobody attached yet, but
        // still recorded that state as `last_title` — clear it here so the
        // subscriber that just attached is guaranteed a `Title` event on the
        // very next tick rather than only once something actually changes
        // again.
        *session.last_title.lock().unwrap() = None;
        let mut shared = session.shared.lock().unwrap();
        if !shared.buffer.is_empty() {
            let _ = channel.send(PtyEvent::Data {
                data: STANDARD.encode(&shared.buffer),
            });
            shared.buffer.clear();
        }
        if let Some(code) = shared.exit_code.take() {
            let _ = channel.send(PtyEvent::Exit { code });
        }
        shared.channel = Some(channel);
        Ok(())
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| AppError::NotFound(format!("unknown terminal: {terminal_id}")))?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| AppError::Other(format!("failed to write to pty: {e}")))
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| AppError::NotFound(format!("unknown terminal: {terminal_id}")))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("failed to resize pty: {e}")))
    }

    pub fn kill(&self, terminal_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(terminal_id) {
            let _ = session.child.kill();
        }
        Ok(())
    }

    /// Kills every remaining session; called from the window-close handler
    /// so no shells are orphaned when the app quits.
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.child.kill();
        }
    }

    /// Runs for the app's entire lifetime on its own thread, re-checking
    /// every live session's cwd/foreground-process once per tick and
    /// pushing a `Title` event wherever it has changed since the last one
    /// reported for that session.
    fn poll_titles_loop(sessions: Arc<Mutex<HashMap<String, PtySession>>>) {
        let mut system = System::new();
        loop {
            std::thread::sleep(TITLE_POLL_INTERVAL);

            // Snapshot id/shell-pid/channel/last-title for every live
            // session, then drop the lock before touching the OS — a
            // session's own spawn/write/resize/kill calls should never
            // block on this scan.
            let snapshots: Vec<SessionPollSnapshot> = {
                let sessions = sessions.lock().unwrap();
                sessions
                    .iter()
                    .filter_map(|(id, session)| {
                        session.shell_pid.map(|pid| {
                            (
                                id.clone(),
                                pid,
                                session.shared.clone(),
                                session.last_title.clone(),
                                session.last_foreign_pid.clone(),
                            )
                        })
                    })
                    .collect()
            };

            for (terminal_id, shell_pid, shared, last_title, last_foreign_pid) in snapshots {
                let Some(new_title) = Self::poll_one(
                    &sessions,
                    &terminal_id,
                    shell_pid,
                    &last_foreign_pid,
                    &mut system,
                ) else {
                    continue;
                };
                let mut last = last_title.lock().unwrap();
                if last.as_ref() != Some(&new_title) {
                    shared
                        .lock()
                        .unwrap()
                        .push_title(new_title.0.clone(), new_title.1.clone());
                    *last = Some(new_title);
                }
            }
        }
    }

    /// Resolves one session's current `(cwd, program)`, or `None` if the
    /// session was killed since the snapshot, or its shell has (momentarily)
    /// vanished from the process table.
    fn poll_one(
        sessions: &Mutex<HashMap<String, PtySession>>,
        terminal_id: &str,
        shell_pid: u32,
        last_foreign_pid: &Mutex<Option<u32>>,
        system: &mut System,
    ) -> Option<TitleSnapshot> {
        // Re-lock just long enough for `tcgetpgrp` (a single syscall on the
        // pty's own fd) — the actual OS-inspection work below (targeted
        // `sysinfo` refreshes) runs with no lock held at all, so it never
        // blocks this session's own spawn/write/resize/kill calls.
        let fg_pid = {
            let sessions = sessions.lock().unwrap();
            sessions.get(terminal_id)?.master.process_group_leader()
        };

        // A foreign foreground process is only "foreign" if its pid differs
        // from the shell's own — a builtin (`cd`, a shell function) never
        // forks, so `tcgetpgrp` correctly keeps reporting the shell's own
        // pid for those.
        let foreign_pid = fg_pid.map(|pid| pid as u32).filter(|&pid| pid != shell_pid);

        let mut pids = vec![Pid::from_u32(shell_pid)];
        if let Some(pid) = foreign_pid {
            pids.push(Pid::from_u32(pid));
        }
        // `remove_dead_processes: true` below only evicts a pid that is
        // actually named in this update's list — a pid that was foreign
        // last tick but has since exited is otherwise never named again
        // (this tick reports no foreign pid at all), so it would stay
        // cached in `system` forever, leaking its `/proc/<pid>/stat` fd on
        // Linux. Naming the previous tick's foreign pid here, even when
        // it's no longer current, gives sysinfo one last chance to see it's
        // dead and evict it.
        let mut last_foreign_pid = last_foreign_pid.lock().unwrap();
        if let Some(previous) = *last_foreign_pid {
            if Some(previous) != foreign_pid {
                pids.push(Pid::from_u32(previous));
            }
        }
        *last_foreign_pid = foreign_pid;
        drop(last_foreign_pid);

        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
        );

        // Always read cwd from the shell's own pid, not the foreground
        // program's — this keeps the folder segment live and correct even
        // mid-command, and doesn't jump the tab's title to a directory a
        // running program `chdir()`s into internally that the user never
        // navigated to themselves.
        let cwd = system
            .process(Pid::from_u32(shell_pid))?
            .cwd()?
            .to_string_lossy()
            .into_owned();

        let program = foreign_pid
            .and_then(|pid| system.process(Pid::from_u32(pid)))
            .map(|process| process.name().to_string_lossy().into_owned());

        Some((cwd, program))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tauri::ipc::InvokeResponseBody;

    /// Polls `condition` until it returns `true`, panicking with `message`
    /// if it hasn't within `timeout` — used throughout instead of a fixed
    /// sleep since the title poller's 1s tick means a fixed short sleep
    /// would be flaky and a fixed long one would be needlessly slow.
    fn wait_for(timeout: Duration, message: &str, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        loop {
            if condition() {
                return;
            }
            if Instant::now() > deadline {
                panic!("{message}");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    type ReceivedTitles = Arc<Mutex<Vec<TitleSnapshot>>>;

    fn title_events_channel() -> (Channel<PtyEvent>, ReceivedTitles) {
        let titles: ReceivedTitles = Arc::new(Mutex::new(Vec::new()));
        let titles_clone = titles.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(PtyEvent::Title { cwd, program }) =
                    serde_json::from_str::<PtyEvent>(&json)
                {
                    titles_clone.lock().unwrap().push((cwd, program));
                }
            }
            Ok(())
        });
        (channel, titles)
    }

    /// Spawns a real shell (no mocking — PTY line discipline, resizing, and
    /// EOF handling are exactly the kind of thing that's subtly wrong when
    /// mocked), writes a command, and asserts the marker shows up in the
    /// `Channel`'s received output within a timeout.
    #[test]
    fn spawned_shell_echoes_written_command() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24)
            .unwrap();

        let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let received_clone = received.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(PtyEvent::Data { data }) = serde_json::from_str::<PtyEvent>(&json) {
                    if let Ok(bytes) = STANDARD.decode(data) {
                        received_clone.lock().unwrap().extend_from_slice(&bytes);
                    }
                }
            }
            Ok(())
        });
        manager.subscribe(&terminal_id, channel).unwrap();

        manager
            .write(&terminal_id, "echo atrium-test-marker\n")
            .unwrap();

        wait_for(
            Duration::from_secs(10),
            "marker never appeared in pty output",
            || String::from_utf8_lossy(&received.lock().unwrap()).contains("atrium-test-marker"),
        );

        manager.kill(&terminal_id).unwrap();
    }

    /// Proves #192's fix: the spawned shell always has `TERM` set, even
    /// though the test process running `cargo test` may or may not have one
    /// of its own (mirroring the `launchd`-launched built app, which has
    /// none) — so this must come from `PtyManager::spawn` explicitly setting
    /// it, not from inheritance.
    #[test]
    fn spawned_shell_has_term_set_to_xterm_256color() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24)
            .unwrap();

        let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let received_clone = received.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(PtyEvent::Data { data }) = serde_json::from_str::<PtyEvent>(&json) {
                    if let Ok(bytes) = STANDARD.decode(data) {
                        received_clone.lock().unwrap().extend_from_slice(&bytes);
                    }
                }
            }
            Ok(())
        });
        manager.subscribe(&terminal_id, channel).unwrap();

        manager.write(&terminal_id, "echo $TERM\n").unwrap();

        wait_for(
            Duration::from_secs(10),
            "TERM value never appeared in pty output",
            || String::from_utf8_lossy(&received.lock().unwrap()).contains("xterm-256color"),
        );

        manager.kill(&terminal_id).unwrap();
    }

    /// The most direct regression guard for #192's reported symptom: `clear`
    /// must not print `TERM environment variable not set`, which only
    /// happens when `TERM` is unset or names a terminfo entry that doesn't
    /// exist on the host.
    #[test]
    fn clear_does_not_report_term_not_set() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24)
            .unwrap();

        let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let received_clone = received.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(PtyEvent::Data { data }) = serde_json::from_str::<PtyEvent>(&json) {
                    if let Ok(bytes) = STANDARD.decode(data) {
                        received_clone.lock().unwrap().extend_from_slice(&bytes);
                    }
                }
            }
            Ok(())
        });
        manager.subscribe(&terminal_id, channel).unwrap();

        // `clear` alone leaves no marker to wait on, so run an echo after it
        // and wait for that instead, then assert over everything received.
        manager
            .write(&terminal_id, "clear; echo atrium-clear-done\n")
            .unwrap();

        wait_for(
            Duration::from_secs(10),
            "marker after clear never appeared in pty output",
            || String::from_utf8_lossy(&received.lock().unwrap()).contains("atrium-clear-done"),
        );

        let output = String::from_utf8_lossy(&received.lock().unwrap()).into_owned();
        assert!(
            !output.contains("TERM environment variable not set"),
            "clear reported a missing TERM: {output}"
        );

        manager.kill(&terminal_id).unwrap();
    }

    /// Proves the core of #152's fix: a real foreground program is detected
    /// and named via OS-level process inspection alone, with no shell
    /// cooperation (no OSC 133 "command started" marker involved at all),
    /// and the report clears back to `None` once the program exits.
    #[test]
    fn foreground_program_reported_while_running_then_cleared_on_exit() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24)
            .unwrap();

        let (channel, titles) = title_events_channel();
        manager.subscribe(&terminal_id, channel).unwrap();

        manager.write(&terminal_id, "sleep 5\n").unwrap();

        wait_for(
            Duration::from_secs(10),
            "no Title event ever reported program: Some(\"sleep\") while it was running",
            || {
                titles
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(_, program)| program.as_deref() == Some("sleep"))
            },
        );

        wait_for(
            Duration::from_secs(10),
            "no Title event reported program: None after the foreground process exited",
            || {
                titles
                    .lock()
                    .unwrap()
                    .last()
                    .is_some_and(|(_, program)| program.is_none())
            },
        );

        manager.kill(&terminal_id).unwrap();
    }

    /// Proves the cwd half of #152's fix: the reported cwd updates after a
    /// plain `cd`, with nothing written to the pty by the shell itself (no
    /// OSC 7) — the poller reads it independently via the shell's own pid.
    #[test]
    fn cwd_updates_after_cd_with_no_shell_cooperation() {
        let manager = PtyManager::new();
        let start_dir = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let target_canonical = std::fs::canonicalize(target_dir.path()).unwrap();

        let terminal_id = manager
            .spawn(start_dir.path().to_string_lossy().to_string(), 80, 24)
            .unwrap();

        let (channel, titles) = title_events_channel();
        manager.subscribe(&terminal_id, channel).unwrap();

        manager
            .write(
                &terminal_id,
                &format!("cd {}\n", target_dir.path().display()),
            )
            .unwrap();

        wait_for(
            Duration::from_secs(10),
            "no Title event ever reported the post-cd cwd",
            || {
                titles.lock().unwrap().iter().any(|(cwd, _)| {
                    std::fs::canonicalize(cwd)
                        .map(|resolved| resolved == target_canonical)
                        .unwrap_or(false)
                })
            },
        );

        manager.kill(&terminal_id).unwrap();
    }

    /// A poll tick that finds nothing changed since the last one must not
    /// emit a redundant `Title` event.
    #[test]
    fn no_title_event_when_nothing_changed_since_last_tick() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24)
            .unwrap();

        let (channel, titles) = title_events_channel();
        manager.subscribe(&terminal_id, channel).unwrap();

        // Let the poller observe the idle shell at least once — its first
        // tick always reports the initial state, since `last_title` starts
        // as `None`.
        wait_for(
            Duration::from_secs(10),
            "no Title event ever arrived",
            || !titles.lock().unwrap().is_empty(),
        );
        let count_after_first_tick = titles.lock().unwrap().len();

        // Nothing changes for several more ticks; no further event should
        // arrive.
        std::thread::sleep(Duration::from_secs(3));
        assert_eq!(
            titles.lock().unwrap().len(),
            count_after_first_tick,
            "a Title event fired for an idle session with nothing changed"
        );

        manager.kill(&terminal_id).unwrap();
    }
}
