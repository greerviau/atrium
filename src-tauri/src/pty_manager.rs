use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

/// Cap on buffered output kept before the frontend calls `pty_subscribe`.
/// Generous enough to hold a shell's startup banner/prompt without growing
/// unbounded if a subscriber never shows up.
const BUFFER_CAP: usize = 64 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PtyEvent {
    #[serde(rename = "data")]
    Data { data: String },
    #[serde(rename = "exit")]
    Exit { code: Option<i32> },
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
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
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

        self.sessions.lock().unwrap().insert(
            terminal_id.clone(),
            PtySession {
                writer,
                master: pair.master,
                child,
                shared,
            },
        );

        Ok(terminal_id)
    }

    pub fn subscribe(
        &self,
        terminal_id: &str,
        channel: Channel<PtyEvent>,
    ) -> Result<(), AppError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| AppError::NotFound(format!("unknown terminal: {terminal_id}")))?;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tauri::ipc::InvokeResponseBody;

    /// Spawns a real shell (no mocking — PTY line discipline, resizing, and
    /// EOF handling are exactly the kind of thing that's subtly wrong when
    /// mocked), writes a command, and asserts the marker shows up in the
    /// `Channel`'s received output within a timeout.
    #[test]
    fn spawned_shell_echoes_written_command() {
        let manager = PtyManager::default();
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

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let seen = received.lock().unwrap().clone();
            if String::from_utf8_lossy(&seen).contains("atrium-test-marker") {
                break;
            }
            if Instant::now() > deadline {
                panic!(
                    "marker never appeared in pty output; got: {:?}",
                    String::from_utf8_lossy(&seen)
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        manager.kill(&terminal_id).unwrap();
    }
}
