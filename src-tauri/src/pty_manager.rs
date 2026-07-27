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

/// How often the shared flush loop drains each live session's `pending`
/// output into a single `Data` event. Well under the ~100ms threshold
/// generally considered perceptible for interactive echo latency, while
/// still coalescing a flood of small reads into a handful of larger sends.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Safety cap on `Shared::pending`: if a burst of output between two flush
/// ticks would push `pending` past this, `push_data` flushes immediately
/// instead of waiting for the next tick. Bounds worst-case memory and
/// message size for a producer fast enough to accumulate megabytes between
/// two `FLUSH_INTERVAL` ticks, without changing the common-case cadence.
const PENDING_CAP: usize = 256 * 1024;

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
    /// Output accumulated since the last flush, once a channel is attached.
    /// Distinct from `buffer` (which only ever holds pre-subscribe output):
    /// this is the live path's coalescing window, drained by
    /// `flush_output_loop` every `FLUSH_INTERVAL`, by `push_data` itself if
    /// `PENDING_CAP` is exceeded first, or by `push_exit` before the last
    /// `Exit` event goes out.
    pending: Vec<u8>,
    exit_code: Option<Option<i32>>,
}

impl Shared {
    fn push_data(&mut self, chunk: &[u8]) {
        match &self.channel {
            Some(_) => {
                self.pending.extend_from_slice(chunk);
                if self.pending.len() > PENDING_CAP {
                    self.flush_pending();
                }
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

    /// Drains `pending` into a single `Data` event, if there's a channel
    /// attached and anything to send. Called on the periodic flush tick,
    /// immediately from `push_data` when `PENDING_CAP` is exceeded, and
    /// from `push_exit` so the last sub-tick burst of output is never
    /// dropped.
    fn flush_pending(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        if let Some(channel) = &self.channel {
            let _ = channel.send(PtyEvent::Data {
                data: STANDARD.encode(&self.pending),
            });
            self.pending.clear();
        }
    }

    fn push_exit(&mut self, code: Option<i32>) {
        self.flush_pending();
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
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
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
    /// Constructs a manager and starts its two shared background threads —
    /// title polling and output flushing. Replaces the previous
    /// `#[derive(Default)]` because both need to be started exactly once,
    /// alongside the sessions map they watch — a session added to the map
    /// later is simply picked up on the next tick of each, and one removed
    /// via `kill` is simply absent from it, with no separate
    /// registration/cancellation needed.
    pub fn new() -> Self {
        let sessions: Arc<Mutex<HashMap<String, PtySession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let poller_sessions = sessions.clone();
        std::thread::spawn(move || Self::poll_titles_loop(poller_sessions));
        let flush_sessions = sessions.clone();
        std::thread::spawn(move || Self::flush_output_loop(flush_sessions));
        Self { sessions }
    }

    /// `shell_override`, when set, is used in place of `$SHELL`/the `/bin/zsh`
    /// fallback. Production callers always pass `None`; it exists so tests
    /// can spawn a specific shell (e.g. `dash`) without mutating the
    /// process-global `SHELL` env var, which would race other tests running
    /// in the same binary.
    pub fn spawn(
        &self,
        cwd: String,
        cols: u16,
        rows: u16,
        shell_override: Option<String>,
    ) -> Result<String, AppError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("failed to open pty: {e}")))?;

        let shell = shell_override
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/zsh".to_string());
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
            pending: Vec::new(),
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
                writer: Arc::new(Mutex::new(writer)),
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
        // Clone the writer handle while `sessions` is locked just long enough
        // for the map lookup, then drop that lock before the write — matching
        // `poll_one`'s pattern of never holding the global lock across OS I/O.
        // A blocked write (PTY input buffer full because the foreground process
        // isn't reading stdin) then only ever blocks this one terminal's own
        // writer mutex, not spawn/resize/write/kill for every other terminal.
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(terminal_id)
                .ok_or_else(|| AppError::NotFound(format!("unknown terminal: {terminal_id}")))?;
            session.writer.clone()
        };
        return writer
            .lock()
            .unwrap()
            .write_all(data.as_bytes())
            .map_err(|e| AppError::Other(format!("failed to write to pty: {e}")));
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
        // Remove the entry under the lock (cheap, no syscalls), then release it
        // before the process-tree walk/signal/wait below — that work doesn't
        // touch the map and shouldn't block every other terminal's own
        // spawn/write/resize/kill while it runs.
        let session = self.sessions.lock().unwrap().remove(terminal_id);
        if let Some(mut session) = session {
            let mut system = System::new();
            Self::kill_session(&mut session, &mut system);
        }
        Ok(())
    }

    /// Kills every remaining session; called from the window-close handler
    /// so no shells are orphaned when the app quits. Shares one `System`
    /// across every session being drained, rather than allocating one per
    /// session, since several tabs are commonly still open at quit.
    pub fn kill_all(&self) {
        // Drain the whole map under the lock (cheap), then release it before
        // reaping each session — same reasoning as `kill` above, but it matters
        // more here: this loop runs once per session, so holding the lock for
        // the whole thing would multiply the stall by however many terminals
        // are open at quit.
        let drained: Vec<PtySession> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, session)| session)
            .collect();
        let mut system = System::new();
        for mut session in drained {
            Self::kill_session(&mut session, &mut system);
        }
    }

    /// Kills every live descendant of `session`'s shell, then the shell
    /// itself, then reaps it. A terminal's shell is only ever the direct
    /// ancestor of whatever it forked (a dev server, a build, `sleep &`), so
    /// walking the process tree from its pid reaches all of it regardless of
    /// whether a given job was left in the foreground or backgrounded — see
    /// the "Signal sequence" section of the issue #251 fix plan.
    ///
    /// This deliberately also reaches a `nohup`/`disown`-ed job: it's still
    /// a child of the shell, so the walk finds it, its `SIGHUP` is a no-op
    /// (that's the point of `nohup`), and it gets `SIGKILL`ed in the same
    /// pass as everything else. Closing a tab is exactly the kind of
    /// deliberate action #251 wants to reap a dev server or build for, and
    /// there's no way to tell "detached on purpose" apart from "just
    /// forgotten" from here.
    fn kill_session(session: &mut PtySession, system: &mut System) {
        let Some(shell_pid) = session.shell_pid else {
            // No pid to walk from; fall back to the previous behavior.
            let _ = session.child.kill();
            let _ = session.child.wait();
            return;
        };

        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let descendants = Self::collect_descendants(system, shell_pid);

        // Best-effort: a descendant may have already exited on its own.
        for &pid in &descendants {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGHUP);
            }
        }

        // portable_pty's `ChildKiller` impl for `std::process::Child` sends
        // SIGHUP to the shell, then polls up to four times 50ms apart (up to
        // ~200ms) before falling back to SIGKILL if the shell is still
        // alive — but only spends any of that time if the shell doesn't die
        // immediately, which a shell with no SIGHUP handler (e.g. `dash`)
        // won't. Whatever time this call does take is reused as the
        // descendants' own grace period instead of adding a second sleep,
        // since the two run concurrently in wall-clock time; it isn't a
        // guaranteed window.
        let _ = session.child.kill();

        if !descendants.is_empty() {
            let pids: Vec<Pid> = descendants.iter().copied().map(Pid::from_u32).collect();
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                ProcessRefreshKind::nothing(),
            );
            for &pid in &descendants {
                if system.process(Pid::from_u32(pid)).is_some() {
                    unsafe {
                        libc::kill(pid as libc::pid_t, libc::SIGKILL);
                    }
                }
            }
        }

        let _ = session.child.wait();
    }

    /// Transitive walk over `system`'s process table, collecting every pid
    /// whose parent chain leads back to `root` (not including `root` itself).
    fn collect_descendants(system: &System, root: u32) -> Vec<u32> {
        let mut descendants = Vec::new();
        let mut frontier = vec![Pid::from_u32(root)];
        while let Some(parent) = frontier.pop() {
            for (pid, process) in system.processes() {
                if process.parent() == Some(parent) {
                    descendants.push(pid.as_u32());
                    frontier.push(*pid);
                }
            }
        }
        descendants
    }

    /// Runs for the app's entire lifetime on its own thread, ticking every
    /// `FLUSH_INTERVAL` and draining each live session's `pending` output
    /// (if any) into a single `Data` event. Mirrors `poll_titles_loop`'s
    /// shape — snapshot session state under a brief lock, then act without
    /// holding it — for the same reason: thread count stays O(1) regardless
    /// of how many terminals are open, and a session is picked up or
    /// dropped automatically by virtue of being present or absent in the
    /// sessions map on the next tick.
    fn flush_output_loop(sessions: Arc<Mutex<HashMap<String, PtySession>>>) {
        loop {
            std::thread::sleep(FLUSH_INTERVAL);

            let shared_handles: Vec<Arc<Mutex<Shared>>> = {
                let sessions = sessions.lock().unwrap();
                sessions
                    .values()
                    .map(|session| session.shared.clone())
                    .collect()
            };

            for shared in shared_handles {
                shared.lock().unwrap().flush_pending();
            }
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

    type ReceivedChunks = Arc<Mutex<Vec<Vec<u8>>>>;

    /// Like the ad hoc `Data`-collecting channels used elsewhere in this
    /// module, but keeps each decoded `Data` payload as its own entry
    /// instead of flattening them into one buffer — needed by the
    /// coalescing tests below, which assert on both the concatenated bytes
    /// and how many separate `Data` events arrived.
    fn data_chunks_channel() -> (Channel<PtyEvent>, ReceivedChunks) {
        let chunks: ReceivedChunks = Arc::new(Mutex::new(Vec::new()));
        let chunks_clone = chunks.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(PtyEvent::Data { data }) = serde_json::from_str::<PtyEvent>(&json) {
                    if let Ok(bytes) = STANDARD.decode(data) {
                        chunks_clone.lock().unwrap().push(bytes);
                    }
                }
            }
            Ok(())
        });
        (channel, chunks)
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
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
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
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
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
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
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
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
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
            .spawn(start_dir.path().to_string_lossy().to_string(), 80, 24, None)
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
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
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

    /// Proves #251's fix for the foreground case: a `sleep 600` typed at the
    /// prompt is gone after `kill()`, not left running as an orphan. This
    /// case happened to already work before the fix (the kernel's own
    /// controlling-terminal-hangup behavior reaches a foreground process
    /// group on its own), so it's kept as a baseline alongside
    /// `backgrounded_descendant_reaped_under_dash_with_no_job_hangup_of_its_own`
    /// below, which is the one that actually exercises the tree walk.
    #[test]
    fn foreground_descendant_reaped_on_kill() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
            .unwrap();

        let (channel, titles) = title_events_channel();
        manager.subscribe(&terminal_id, channel).unwrap();

        manager.write(&terminal_id, "sleep 600\n").unwrap();

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

        let shell_pid = manager
            .sessions
            .lock()
            .unwrap()
            .get(&terminal_id)
            .unwrap()
            .shell_pid
            .unwrap();
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let sleep_pid = PtyManager::collect_descendants(&system, shell_pid)
            .into_iter()
            .find(|&pid| {
                system
                    .process(Pid::from_u32(pid))
                    .is_some_and(|process| process.name().to_str() == Some("sleep"))
            })
            .expect("sleep process not found among the shell's descendants");

        manager.kill(&terminal_id).unwrap();

        // `kill()` reaps the shell but doesn't wait for a descendant's own
        // exit/reparent/reap by init — for a brief window after it returns,
        // the pid is still in the process table as a zombie, which would
        // read as "still alive" to a single immediate check. Poll instead of
        // asserting once.
        wait_for(
            Duration::from_secs(5),
            &format!("foreground sleep process {sleep_pid} still alive after kill()"),
            || {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[Pid::from_u32(sleep_pid)]),
                    true,
                    ProcessRefreshKind::nothing(),
                );
                system.process(Pid::from_u32(sleep_pid)).is_none()
            },
        );
    }

    /// Proves #251's fix for the backgrounded case: a `sleep 300 &`, under a
    /// shell with no job-hangup behavior of its own, is gone after `kill()`.
    /// This is the case that was confirmed to leak before the fix — `dash`
    /// has no job table to forward a received `SIGHUP` through, and the
    /// kernel's automatic hangup only ever reaches the terminal's *current
    /// foreground* process group, which a backgrounded job isn't part of —
    /// so this is the test that actually proves the tree-walk fix, unlike
    /// the foreground case above, which already passed by accident.
    ///
    /// The session's shell is set to `/bin/dash` via `PtyManager::spawn`'s
    /// `shell_override` parameter rather than the process-global `SHELL` env
    /// var, so this test can't race any other test in this binary.
    #[test]
    fn backgrounded_descendant_reaped_under_dash_with_no_job_hangup_of_its_own() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(
                dir.path().to_string_lossy().to_string(),
                80,
                24,
                Some("/bin/dash".to_string()),
            )
            .unwrap();

        let shell_pid = manager
            .sessions
            .lock()
            .unwrap()
            .get(&terminal_id)
            .unwrap()
            .shell_pid
            .unwrap();

        manager.write(&terminal_id, "sleep 300 &\n").unwrap();

        let mut system = System::new();
        let mut sleep_pid = None;
        wait_for(
            Duration::from_secs(10),
            "backgrounded sleep process never appeared as a descendant of the shell",
            || {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing(),
                );
                sleep_pid = PtyManager::collect_descendants(&system, shell_pid)
                    .into_iter()
                    .find(|&pid| {
                        system
                            .process(Pid::from_u32(pid))
                            .is_some_and(|process| process.name().to_str() == Some("sleep"))
                    });
                sleep_pid.is_some()
            },
        );
        let sleep_pid = sleep_pid.unwrap();

        manager.kill(&terminal_id).unwrap();

        // See the identical comment in `foreground_descendant_reaped_on_kill`:
        // the pid is briefly a zombie after `kill()` returns, so poll rather
        // than asserting once.
        wait_for(
            Duration::from_secs(5),
            &format!("backgrounded sleep process {sleep_pid} still alive after kill()"),
            || {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[Pid::from_u32(sleep_pid)]),
                    true,
                    ProcessRefreshKind::nothing(),
                );
                system.process(Pid::from_u32(sleep_pid)).is_none()
            },
        );
    }

    /// Regression test for issue #262: `write` used to hold the global
    /// `sessions` lock across the blocking `write_all` call, so a write that
    /// couldn't drain (the pty's kernel-side input buffer full because the
    /// foreground process isn't reading stdin) stalled every other
    /// terminal's own spawn/write/resize/kill for as long as the write
    /// stayed blocked. After the fix, only the stalled terminal's own writer
    /// mutex is held across the blocking write, so spawning a second
    /// terminal never waits on it.
    #[test]
    fn write_does_not_block_other_terminals_when_pty_input_buffer_is_full() {
        let manager = PtyManager::new();
        let dir_a = tempfile::tempdir().unwrap();
        let terminal_a = manager
            .spawn(dir_a.path().to_string_lossy().to_string(), 80, 24, None)
            .unwrap();

        let (channel_a, titles_a) = title_events_channel();
        manager.subscribe(&terminal_a, channel_a).unwrap();

        // A foreground process that never reads stdin, so nothing ever
        // drains the pty's kernel-side input buffer.
        manager.write(&terminal_a, "sleep 600\n").unwrap();
        wait_for(
            Duration::from_secs(10),
            "no Title event ever reported program: Some(\"sleep\") while it was running",
            || {
                titles_a
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(_, program)| program.as_deref() == Some("sleep"))
            },
        );

        std::thread::scope(|scope| {
            // Large enough that draining it through the pty's line
            // discipline (nothing ever reads it, since `sleep 600` never
            // touches stdin) takes several seconds — comfortably longer than
            // the bound asserted below, so this thread is still inside
            // `write_all` when the assertion runs.
            let writer_thread = scope.spawn(|| manager.write(&terminal_a, &"x".repeat(50_000_000)));

            // Give the writer thread a moment to actually enter the write
            // before proceeding.
            std::thread::sleep(Duration::from_millis(300));

            let dir_b = tempfile::tempdir().unwrap();
            let start = Instant::now();
            let terminal_b = manager
                .spawn(dir_b.path().to_string_lossy().to_string(), 80, 24, None)
                .unwrap();
            assert!(
                start.elapsed() < Duration::from_millis(1500),
                "spawn() for a second terminal was blocked by terminal a's stalled write"
            );

            manager.kill(&terminal_a).unwrap();
            manager.kill(&terminal_b).unwrap();

            let _ = writer_thread.join().unwrap();
        });
    }

    /// Regression test for the `kill`/`kill_all` lock-scope defect surfaced
    /// while fixing #262: reaping a session used to hold the global
    /// `sessions` lock across `kill_session`'s full descendant walk, signal
    /// loop, and `child.wait()`, which stalled every other terminal's own
    /// spawn/write/resize/kill for the duration. After the fix, the map is
    /// only locked long enough to remove the entry being reaped.
    #[test]
    fn kill_does_not_block_other_terminals_while_reaping() {
        let manager = PtyManager::new();
        let dir_a = tempfile::tempdir().unwrap();
        let terminal_a = manager
            .spawn(
                dir_a.path().to_string_lossy().to_string(),
                80,
                24,
                Some("/bin/dash".to_string()),
            )
            .unwrap();

        // Several backgrounded descendants so `kill_session`'s tree walk and
        // signal loop have non-trivial work to do.
        for _ in 0..5 {
            manager.write(&terminal_a, "sleep 300 &\n").unwrap();
        }

        let shell_pid = manager
            .sessions
            .lock()
            .unwrap()
            .get(&terminal_a)
            .unwrap()
            .shell_pid
            .unwrap();
        let mut system = System::new();
        wait_for(
            Duration::from_secs(10),
            "backgrounded sleep descendants never appeared under the shell",
            || {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing(),
                );
                PtyManager::collect_descendants(&system, shell_pid)
                    .into_iter()
                    .filter(|&pid| {
                        system
                            .process(Pid::from_u32(pid))
                            .is_some_and(|process| process.name().to_str() == Some("sleep"))
                    })
                    .count()
                    >= 5
            },
        );

        let dir_b = tempfile::tempdir().unwrap();
        let terminal_b = manager
            .spawn(dir_b.path().to_string_lossy().to_string(), 80, 24, None)
            .unwrap();

        std::thread::scope(|scope| {
            let kill_thread = scope.spawn(|| manager.kill(&terminal_a));

            // Give the kill thread a moment to actually start and acquire
            // the sessions lock before `resize` below tries for it — without
            // this, `resize` on the main thread routinely wins the race to
            // spawn a fresh OS thread and never contends on the lock at all.
            std::thread::sleep(Duration::from_millis(2));

            // `resize` is just an ioctl and normally returns in well under a
            // millisecond; 10ms leaves ample margin for scheduling jitter
            // while staying well below the tens of milliseconds
            // `kill_session`'s process-table refresh and signal loop take
            // (measured ~28ms for a shell with 5 descendants on this
            // machine), so this bound only passes if `resize` truly wasn't
            // serialized behind terminal a's reaping.
            let start = Instant::now();
            manager.resize(&terminal_b, 100, 40).unwrap();
            assert!(
                start.elapsed() < Duration::from_millis(10),
                "resize() for another terminal was blocked by terminal a's reaping"
            );

            kill_thread.join().unwrap().unwrap();
        });

        manager.kill(&terminal_b).unwrap();
    }

    /// Regression test for issue #261: a fast, sustained burst of output
    /// (far more than one 4096-byte `read()`'s worth) must be coalesced
    /// into a handful of `Data` events by `flush_output_loop` instead of
    /// one event per underlying read, while every byte still arrives
    /// intact and in order.
    #[test]
    fn flood_output_is_coalesced_into_few_data_events() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
            .unwrap();

        let (channel, chunks) = data_chunks_channel();
        manager.subscribe(&terminal_id, channel).unwrap();

        // `tr` over `/dev/zero` produces a fast, sustained burst with no
        // embedded newlines, so the pty's output post-processing (which can
        // rewrite `\n` to `\r\n`) can't perturb the byte count checked
        // below. The fill byte is spelled as the octal escape `\101`
        // rather than a literal `A` so the typed command line itself (which
        // the pty echoes back verbatim as it's typed) contains no `A` to
        // contaminate the count.
        manager
            .write(
                &terminal_id,
                "head -c 500000 /dev/zero | tr '\\000' '\\101'; echo atrium-flood-done\n",
            )
            .unwrap();

        // The longest contiguous run of the fill byte, rather than its
        // total count: a stray `A` can legitimately show up elsewhere in
        // the stream (e.g. inside `tempfile::tempdir()`'s random directory
        // name, echoed back as part of the shell prompt), but only an
        // intact, unreordered delivery of the burst produces one unbroken
        // run exactly `burst_len` long.
        fn longest_run_of(bytes: &[u8], target: u8) -> usize {
            let mut longest = 0;
            let mut current = 0;
            for &b in bytes {
                if b == target {
                    current += 1;
                    longest = longest.max(current);
                } else {
                    current = 0;
                }
            }
            longest
        }

        // Wait on the fill-byte run itself reaching the full burst size,
        // rather than the `echo` marker's text: the marker's own text is
        // echoed back the instant it's typed (before the shell has even
        // started running the flood command), so gating on it would race
        // the burst instead of waiting for it.
        wait_for(
            Duration::from_secs(10),
            "flood output never fully arrived",
            || {
                let concatenated: Vec<u8> =
                    chunks.lock().unwrap().iter().flatten().copied().collect();
                longest_run_of(&concatenated, b'A') >= 500_000
            },
        );

        let received = chunks.lock().unwrap();
        let concatenated: Vec<u8> = received.iter().flatten().copied().collect();
        assert_eq!(
            longest_run_of(&concatenated, b'A'),
            500_000,
            "not all flood bytes arrived intact and in order — coalescing must not lose or reorder data"
        );

        // Without coalescing, 500,000 bytes at up to 4096 bytes per read
        // would produce on the order of 122 separate `Data` events. The
        // flush loop should collapse that down to a small number of larger
        // sends instead, bounded by flush cadence rather than input size.
        assert!(
            received.len() < 40,
            "expected the flood to be coalesced into a handful of Data events, got {}",
            received.len()
        );

        manager.kill(&terminal_id).unwrap();
    }

    /// Regression test for issue #261: output still sitting in `pending`
    /// when the reader thread hits EOF must be flushed before the `Exit`
    /// event, not silently dropped.
    #[test]
    fn pending_output_flushed_before_exit_event() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
            .unwrap();

        let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let received_clone = received.clone();
        let exited = Arc::new(Mutex::new(false));
        let exited_clone = exited.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                match serde_json::from_str::<PtyEvent>(&json) {
                    Ok(PtyEvent::Data { data }) => {
                        if let Ok(bytes) = STANDARD.decode(data) {
                            received_clone.lock().unwrap().extend_from_slice(&bytes);
                        }
                    }
                    Ok(PtyEvent::Exit { .. }) => {
                        *exited_clone.lock().unwrap() = true;
                    }
                    _ => {}
                }
            }
            Ok(())
        });
        manager.subscribe(&terminal_id, channel).unwrap();

        manager
            .write(&terminal_id, "echo atrium-exit-tail; exit\n")
            .unwrap();

        wait_for(Duration::from_secs(10), "shell never reported exit", || {
            *exited.lock().unwrap()
        });

        let output = String::from_utf8_lossy(&received.lock().unwrap()).into_owned();
        assert!(
            output.contains("atrium-exit-tail"),
            "final output before exit was dropped: {output}"
        );

        manager.kill(&terminal_id).unwrap();
    }

    /// Regression test for issue #261: the coalescing window must not turn
    /// into a "stuck buffer" — a small write after an idle period should
    /// still arrive within roughly one `FLUSH_INTERVAL`, not sit buffered
    /// until some later event nudges it out.
    #[test]
    fn output_after_idle_period_arrives_within_roughly_one_flush_interval() {
        let manager = PtyManager::new();
        let dir = tempfile::tempdir().unwrap();
        let terminal_id = manager
            .spawn(dir.path().to_string_lossy().to_string(), 80, 24, None)
            .unwrap();

        let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        // Timestamped inside the channel closure, right as the marker
        // actually lands, rather than derived from a `wait_for` poll loop —
        // `wait_for` only samples every 50ms, which would quantize any
        // measurement taken after it returns to that cadence and make a
        // tight, meaningful bound impossible to assert on.
        let arrived_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let received_clone = received.clone();
        let arrived_at_clone = arrived_at.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(PtyEvent::Data { data }) = serde_json::from_str::<PtyEvent>(&json) {
                    if let Ok(bytes) = STANDARD.decode(data) {
                        let mut received = received_clone.lock().unwrap();
                        received.extend_from_slice(&bytes);
                        if String::from_utf8_lossy(&received).contains("atrium-idle-burst-marker") {
                            arrived_at_clone
                                .lock()
                                .unwrap()
                                .get_or_insert_with(Instant::now);
                        }
                    }
                }
            }
            Ok(())
        });
        manager.subscribe(&terminal_id, channel).unwrap();

        // Let the pty settle into an idle prompt before measuring.
        std::thread::sleep(Duration::from_millis(200));
        received.lock().unwrap().clear();

        let start = Instant::now();
        manager
            .write(&terminal_id, "echo atrium-idle-burst-marker\n")
            .unwrap();

        wait_for(
            Duration::from_secs(5),
            "output after an idle period took too long to arrive",
            || arrived_at.lock().unwrap().is_some(),
        );

        // `FLUSH_INTERVAL` is 8ms, so an exact measurement should land in
        // low tens of milliseconds; 60ms leaves headroom for scheduling
        // jitter while still being tight enough to catch a real regression
        // (e.g. a coalescing window with no periodic flush at all, which
        // would leave the marker sitting unflushed far longer than this).
        // Deliberately not a round multiple of `wait_for`'s own 50ms poll
        // cadence, even though this measurement no longer derives from it,
        // so the two can never coincidentally land on the same boundary.
        let elapsed = arrived_at.lock().unwrap().unwrap() - start;
        assert!(
            elapsed < Duration::from_millis(60),
            "expected idle-then-burst output to arrive within about one flush interval, took {:?}",
            elapsed
        );

        manager.kill(&terminal_id).unwrap();
    }
}
