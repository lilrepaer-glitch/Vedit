// Vedit desktop shell (Tauri v2 — Windows, macOS & Linux) — PLAN.md §6, §7 (F5).
// Hosts the native desktop editor window and launches the local Vedit REST + WebSocket
// sidecar process (bundled Node.js + compiled server + FFmpeg/ffprobe binaries).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;
use tauri::Manager;

struct Sidecar(std::sync::Mutex<Option<Child>>);

fn find_resource(res: &Path, rel: &str) -> PathBuf {
    let nested = res.join("resources").join(rel);
    if nested.exists() {
        nested
    } else {
        res.join(rel)
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
    fallback.join("data")
}

fn is_port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(80)).is_ok()
}

fn wait_for_port(port: u16, timeout_ms: u64) {
    let step = Duration::from_millis(80);
    let max_tries = (timeout_ms / 80).max(1);
    for _ in 0..max_tries {
        if is_port_open(port) {
            return;
        }
        std::thread::sleep(step);
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Sidecar(std::sync::Mutex::new(None)))
        .setup(|app| {
            if is_port_open(47000) {
                return Ok(());
            }

            let res = app
                .path()
                .resource_dir()
                .map_err(|e| format!("resource dir: {e}"))?;

            let node = find_executable(&res, "node/node");
            let entry = find_resource(&res, "server/dist/cli/index.js");
            let ffmpeg = find_executable(&res, "bin/ffmpeg");
            let ffprobe = find_executable(&res, "bin/ffprobe");
            if !node.exists() || !entry.exists() {
                return Err(format!("missing sidecar files in {}", res.display()).into());
            }

            let data_dir = default_user_data_dir(&res);
            let server_dir = entry
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| res.clone());

            let mut cmd = Command::new(&node);
            cmd.arg(&entry)
                .args([
                    "serve",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "47000",
                    "--token",
                    "dev",
                ])
                .current_dir(&server_dir)
                .env("VEDIT_DATA", &data_dir)
                .env("VEDIT_FFMPEG", &ffmpeg)
                .env("VEDIT_FFPROBE", &ffprobe)
                .env("VEDIT_PYTHON", "");

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let child = cmd.spawn().map_err(|e| format!("start API server: {e}"))?;
            *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
            wait_for_port(47000, 8000);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Vedit desktop application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
