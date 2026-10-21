// Vedit desktop shell (Tauri v2 — Windows, macOS & Linux) — PLAN.md §6, §7.
// Hosts the native desktop editor window, selects an available non-excluded loopback TCP port
// (bypassing Windows 11 Hyper-V / WinNAT excluded port ranges around 47000), supervises the bundled
// Node.js + FFmpeg sidecar, and navigates WebView2 directly onto same-origin `http://127.0.0.1:<port>/`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{create_dir_all, read_to_string, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

struct SidecarState {
    child: Mutex<Option<Child>>,
    port: AtomicU16,
    last_error: Mutex<Option<String>>,
    navigated: AtomicBool,
}

/// Strips Windows `\\?\` extended-length path prefix (`\\?\C:\...` -> `C:\...`),
/// which otherwise breaks Node.js ESM module path resolution on Windows 10/11.
fn clean_windows_path(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    p
}

fn find_resource(res: &Path, rel: &str) -> PathBuf {
    let nested = res.join("resources").join(rel);
    if nested.exists() {
        clean_windows_path(nested)
    } else {
        clean_windows_path(res.join(rel))
    }
}

fn find_executable(res: &Path, stem: &str) -> PathBuf {
    #[cfg(windows)]
    {
        find_resource(res, &format!("{stem}.exe"))
    }
    #[cfg(not(windows))]
    {
        let native = find_resource(res, stem);
        if native.exists() {
            native
        } else {
            find_resource(res, &format!("{stem}.exe"))
        }
    }
}

fn default_user_data_dir(fallback: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(p).join("Vedit");
    }
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Vedit");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(xdg).join("Vedit");
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local").join("share").join("Vedit");
        }
    }
    clean_windows_path(fallback.join("data"))
}

/// Verifies that an actual Vedit Engine HTTP server is answering `/api/v1/health` on `127.0.0.1:<port>`
/// (so another unrelated Windows process or stale zombie socket never tricks Vedit into thinking it is ready!).
fn is_vedit_healthy(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(120)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    let req = format!("GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 512];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let text = String::from_utf8_lossy(&buf[..n]);
    text.contains("\"vedit\"")
}

/// Finds a guaranteed bindable TCP port on `127.0.0.1`:
/// 1) Reuses an already-healthy Vedit instance on `47000` if present.
/// 2) Otherwise tests real OS `TcpListener::bind` across `47000..=47100` (skipping Windows Hyper-V / WinNAT excluded ranges!).
/// 3) Falls back to OS-assigned ephemeral port `0` if every port in `47000..=47100` is reserved.
fn pick_sidecar_port() -> u16 {
    if is_vedit_healthy(47000) {
        return 47000;
    }
    for port in 47000..=47100 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            drop(listener);
            return port;
        }
    }
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) {
        if let Ok(addr) = listener.local_addr() {
            return addr.port();
        }
    }
    47000
}

fn wait_for_healthy(port: u16, timeout_ms: u64) -> bool {
    let step = Duration::from_millis(75);
    let max_tries = (timeout_ms / 75).max(1);
    for _ in 0..max_tries {
        if is_vedit_healthy(port) {
            return true;
        }
        std::thread::sleep(step);
    }
    is_vedit_healthy(port)
}

fn spawn_sidecar_once(res: &Path, data_dir: &Path, log_path: &Path, port: u16) -> Result<Child, String> {
    let node = find_executable(res, "node/node");
    let entry = find_resource(res, "server/dist/cli/index.js");
    let ffmpeg = find_executable(res, "bin/ffmpeg");
    let ffprobe = find_executable(res, "bin/ffprobe");

    if !node.exists() || !entry.exists() {
        return Err(format!(
            "Missing sidecar files: node={} (exists={}), entry={} (exists={})",
            node.display(),
            node.exists(),
            entry.display(),
            entry.exists()
        ));
    }

    let server_dir = clean_windows_path(
        entry
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| res.to_path_buf()),
    );

    if let Some(parent) = log_path.parent() {
        let _ = create_dir_all(parent);
    }
    let _ = create_dir_all(data_dir);

    let stdout_stdio = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let stderr_stdio = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());

    let port_str = port.to_string();
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .args([
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            &port_str,
            "--token",
            "dev",
        ])
        .current_dir(&server_dir)
        .stdin(Stdio::null())
        .stdout(stdout_stdio)
        .stderr(stderr_stdio)
        .env("VEDIT_DATA", data_dir)
        .env("VEDIT_FFMPEG", &ffmpeg)
        .env("VEDIT_FFPROBE", &ffprobe)
        .env("VEDIT_PYTHON", "");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to spawn sidecar {}: {e}", node.display()))
}

fn main() {
    let shared = Arc::new(SidecarState {
        child: Mutex::new(None),
        port: AtomicU16::new(47000),
        last_error: Mutex::new(None),
        navigated: AtomicBool::new(false),
    });
    let setup_state = Arc::clone(&shared);
    let exit_state = Arc::clone(&shared);

    tauri::Builder::default()
        .setup(move |app| {
            let res = clean_windows_path(
                app.path()
                    .resource_dir()
                    .map_err(|e| format!("resource dir: {e}"))?,
            );
            let data_dir = default_user_data_dir(&res);
            let log_path = data_dir.join("logs").join("sidecar.log");

            let chosen_port = pick_sidecar_port();
            setup_state.port.store(chosen_port, Ordering::SeqCst);

            if !is_vedit_healthy(chosen_port) {
                match spawn_sidecar_once(&res, &data_dir, &log_path, chosen_port) {
                    Ok(child) => {
                        *setup_state.child.lock().unwrap() = Some(child);
                    }
                    Err(err) => {
                        *setup_state.last_error.lock().unwrap() = Some(err);
                    }
                }
            }

            // Navigate main window onto same-origin `http://127.0.0.1:<chosen_port>/` immediately when healthy!
            if wait_for_healthy(chosen_port, 2500) {
                if let Some(win) = app.webview_windows().values().next() {
                    if let Ok(url) = format!("http://127.0.0.1:{chosen_port}/").parse::<tauri::Url>() {
                        let _ = win.navigate(url);
                        setup_state.navigated.store(true, Ordering::SeqCst);
                    }
                }
            }

            // Background supervisor: handles slow first-launch Windows Defender scans, auto-restarts crashed sidecars
            // on a fresh available port, navigates WebView2 once healthy, and streams live diagnostics onto screen.
            let sup_state = Arc::clone(&setup_state);
            let app_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(600));
                let cur_port = sup_state.port.load(Ordering::SeqCst);
                if is_vedit_healthy(cur_port) {
                    if !sup_state.navigated.swap(true, Ordering::SeqCst) {
                        if let Some(win) = app_handle.webview_windows().values().next() {
                            if let Ok(url) = format!("http://127.0.0.1:{cur_port}/").parse::<tauri::Url>() {
                                let _ = win.navigate(url);
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(1400));
                    continue;
                }

                let need_spawn = {
                    let mut guard = sup_state.child.lock().unwrap();
                    match guard.as_mut() {
                        Some(ch) => match ch.try_wait() {
                            Ok(Some(status)) => {
                                *sup_state.last_error.lock().unwrap() =
                                    Some(format!("Sidecar exited with status {status}"));
                                *guard = None;
                                true
                            }
                            Ok(None) => false, // Still starting (Windows Defender SmartScreen scan)
                            Err(e) => {
                                *sup_state.last_error.lock().unwrap() =
                                    Some(format!("Sidecar check error: {e}"));
                                *guard = None;
                                true
                            }
                        },
                        None => true,
                    }
                };

                if !sup_state.navigated.load(Ordering::SeqCst) {
                    let err_msg = sup_state.last_error.lock().unwrap().clone().unwrap_or_default();
                    let tail = read_to_string(&log_path)
                        .unwrap_or_default()
                        .lines()
                        .rev()
                        .take(3)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join(" | ");
                    let combined = format!("{err_msg} {tail}").trim().to_string();
                    if !combined.is_empty() {
                        if let Some(win) = app_handle.webview_windows().values().next() {
                            if let Ok(js_str) = serde_json::to_string(&combined) {
                                let _ = win.eval(&format!("window.__VEDIT_DIAG__ = {js_str};"));
                            }
                        }
                    }
                }

                if need_spawn {
                    let next_port = pick_sidecar_port();
                    sup_state.port.store(next_port, Ordering::SeqCst);
                    if !is_vedit_healthy(next_port) {
                        match spawn_sidecar_once(&res, &data_dir, &log_path, next_port) {
                            Ok(child) => {
                                *sup_state.child.lock().unwrap() = Some(child);
                            }
                            Err(err) => {
                                *sup_state.last_error.lock().unwrap() = Some(err);
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Vedit desktop application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = exit_state.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
