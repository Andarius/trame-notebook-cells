// The Jupyter Server the plugin runs itself while it is enabled and no server URL is set.
use super::{ID, Server, user_bin};
use crate::plugins::api::{Native, settings};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Notify;

const TICK: Duration = Duration::from_secs(5);
// the first run downloads jupyter-server and ipykernel
const READY_WITHIN: Duration = Duration::from_mins(3);
const RETRY_AFTER: Duration = Duration::from_mins(1);

struct State {
    pid: Option<u32>,
    server: Option<Server>,
    ready: bool,
    error: Option<String>,
    failed_at: Option<Instant>,
    // bumped on every spawn and kill, so a stale watcher stays quiet
    generation: u64,
}

static STATE: Mutex<State> = Mutex::new(State {
    pid: None,
    server: None,
    ready: false,
    error: None,
    failed_at: None,
    generation: 0,
});
static WAKE: Notify = Notify::const_new();

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(super) fn wanted(slice: &Value) -> bool {
    slice["enabled"] == true && slice["serverUrl"].as_str().unwrap_or("").is_empty()
}

/// The managed server once it answers, else why it cannot be used yet.
pub(super) fn server() -> Result<Server> {
    let s = state();
    if let (Some(server), true) = (&s.server, s.ready) {
        return Ok(server.clone());
    }
    match (&s.error, s.pid) {
        (Some(e), _) => bail!("the Jupyter server failed to start: {e}"),
        (None, Some(_)) => bail!("the Jupyter server is starting"),
        (None, None) => bail!("no Jupyter server configured"),
    }
}

/// `{state, url, error}` for the settings view; null when the user points at their own server.
pub(super) fn view(slice: &Value) -> Value {
    if !slice["serverUrl"].as_str().unwrap_or("").is_empty() {
        return Value::Null;
    }
    let s = state();
    let status = match (&s.error, s.ready, s.pid) {
        (Some(_), _, _) => "failed",
        (None, true, _) => "ready",
        (None, false, Some(_)) => "starting",
        (None, false, None) => "off",
    };
    json!({"state": status, "url": s.server.as_ref().map(|v| &v.url), "error": s.error})
}

pub(super) fn run(native: Native) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            reconcile(wanted(&settings::plugin(&native.settings, ID)));
            tokio::select! {
                () = WAKE.notified() => {}
                () = tokio::time::sleep(TICK) => {}
            }
        }
    })
}

pub(super) fn wake() {
    WAKE.notify_one();
}

pub(super) fn stop() {
    kill(&mut state());
}

fn reconcile(want: bool) {
    let mut s = state();
    if !want {
        kill(&mut s);
        s.error = None;
        s.failed_at = None;
        return;
    }
    if s.pid.is_some() || s.failed_at.is_some_and(|t| t.elapsed() < RETRY_AFTER) {
        return;
    }
    if let Err(e) = spawn(&mut s) {
        fail(&mut s, format!("{e:#}"));
    }
}

fn fail(s: &mut State, error: String) {
    s.pid = None;
    s.server = None;
    s.ready = false;
    s.error = Some(error);
    s.failed_at = Some(Instant::now());
}

fn kill(s: &mut State) {
    s.generation += 1;
    s.server = None;
    s.ready = false;
    let Some(pid) = s.pid.take() else { return };
    // the group: uv and the jupyter-server it runs (the kill binary, as plugins may not use unsafe)
    let _ = std::process::Command::new("kill")
        .args(["-TERM", "--", &format!("-{pid}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

// After the readiness probe: false when this server is gone (replaced, killed or timed out).
fn answered(generation: u64, ok: bool) -> bool {
    let mut s = state();
    if s.generation != generation {
        return false;
    }
    if !ok {
        kill(&mut s);
        fail(&mut s, "no answer within 3 minutes".into());
        return false;
    }
    s.ready = true;
    true
}

/// `uv tool run` fetches jupyter-server with ipykernel (the default python3 kernel); else one on PATH.
fn command() -> Result<Command> {
    if let Some(uv) = user_bin("uv") {
        let mut cmd = Command::new(uv);
        cmd.args([
            "tool",
            "run",
            "--from",
            "jupyter-server",
            "--with",
            "ipykernel",
            "jupyter-server",
        ]);
        return Ok(cmd);
    }
    let bin = user_bin("jupyter-server").context("uv not found (it fetches jupyter-server)")?;
    Ok(Command::new(bin))
}

fn spawn(s: &mut State) -> Result<()> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let home = std::env::var_os("HOME").unwrap_or_else(|| "/".into());
    let mut cmd = command()?;
    cmd.args([
        "--no-browser",
        "--ServerApp.ip=127.0.0.1",
        &format!("--ServerApp.port={port}"),
        "--ServerApp.port_retries=0",
    ])
    // env, not argv: other local users can read argv
    .env("JUPYTER_TOKEN", &token)
    .current_dir(&home)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    cmd.process_group(0);
    let child = cmd.spawn().context("jupyter-server did not start")?;
    let server = Server {
        url: format!("http://127.0.0.1:{port}"),
        token,
    };
    s.generation += 1;
    s.pid = child.id();
    s.server = Some(server.clone());
    s.ready = false;
    s.error = None;
    s.failed_at = None;
    tokio::spawn(watch(s.generation, child, server));
    Ok(())
}

// Marks the server ready once it answers, and failed if it exits or never answers.
async fn watch(generation: u64, mut child: Child, server: Server) {
    let last_line = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let last_line = Arc::clone(&last_line);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    *last_line.lock().unwrap_or_else(PoisonError::into_inner) = line;
                }
            }
        });
    }
    let answers = async {
        let deadline = Instant::now() + READY_WITHIN;
        while Instant::now() < deadline {
            if server.get("/api/status").await.is_ok() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        false
    };
    let exited = tokio::select! {
        ok = answers => {
            if !answered(generation, ok) {
                return;
            }
            child.wait().await
        }
        status = child.wait() => status,
    };
    let mut s = state();
    if s.generation == generation {
        let last = last_line
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let code = exited.map_or_else(|e| e.to_string(), |st| st.to_string());
        fail(&mut s, format!("jupyter-server exited ({code}): {last}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_only_while_enabled_without_a_server_url() {
        assert!(wanted(&json!({"enabled": true})));
        assert!(wanted(&json!({"enabled": true, "serverUrl": ""})));
        assert!(!wanted(
            &json!({"enabled": true, "serverUrl": "http://127.0.0.1:8888"})
        ));
        assert!(!wanted(&json!({"enabled": false})));
    }
}
