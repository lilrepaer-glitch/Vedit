// Vedit desktop shell (Tauri v2) — PLAN.md §6.
// Hosts the React editor window while running the Vedit REST + WebSocket engine
// as a local background sidecar process (bundled Node.js + server dist + FFmpeg/ffprobe).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command};
use std::time::Duration;
use tauri::Manager;

struct Sidecar(std::sync::Mutex<Option<Child>>);

fn find_resource(res: &std::path::Path, rel: &str) -> std::path::PathBuf {
    let nested = res.join("resources").join(rel);
    if nested.exists() {
        nested
    } else {
        res.join(rel)
    }
}

fn wait_for_port(port: u16, timeout_ms: u64) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let step = Duration::from_millis(80);
    let max_tries = (timeout_ms / 80).max(1);
    for _ in 0..max_tries {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(80)).is_ok() {
            return;
        }
        std::thread::sleep(step);
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Sidecar(std::sync::Mutex::new(None)))
        .setup(|app| {
            let res = app
                .path()
                .resource_dir()
                .map_err(|e| format!("resource dir: {e}"))?;

            let node = find_resource(&res, "node/node.exe");
            let entry = find_resource(&res, "server/dist/cli/index.js");
            let ffmpeg = find_resource(&res, "bin/ffmpeg.exe");
            let ffprobe = find_resource(&res, "bin/ffprobe.exe");
            if !node.exists() || !entry.exists() {
                return Err(format!("missing sidecar files in {}", res.display()).into());
            }

            let data_dir = std::env::var("LOCALAPPDATA")
                .map(|p| std::path::PathBuf::from(p).join("Vedit"))
                .unwrap_or_else(|_| res.join("data"));

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
            wait_for_port(47000, 3500);
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
