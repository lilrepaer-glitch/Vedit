// Vedit desktop shell (Tauri) — PLAN.md §6.
// Okno hostuje React UI; REST+WS API server běží jako sidecar proces
// (bundlovaný Node.js + dist/ server + FFmpeg binárky v resources/).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use tauri::Manager;

/// Živý sidecar proces API serveru — ukončí se spolu s aplikací.
struct Sidecar(std::sync::Mutex<Option<Child>>);

/// Najde soubor v resources/ (funguje pro `$RESOURCE/resources/…` i `$RESOURCE/…`).
fn find_resource(res: &std::path::Path, rel: &str) -> std::path::PathBuf {
    let nested = res.join("resources").join(rel);
    if nested.exists() {
        nested
    } else {
        res.join(rel)
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Sidecar(std::sync::Mutex::new(None)))
        .setup(|app| {
            let res = app.path().resource_dir().map_err(|e| format!("resource dir: {e}"))?;

            let node = find_resource(&res, "node/node.exe");
            let entry = find_resource(&res, "server/dist/cli/index.js");
            let ffmpeg = find_resource(&res, "bin/ffmpeg.exe");
            let ffprobe = find_resource(&res, "bin/ffprobe.exe");
            if !node.exists() || !entry.exists() {
                return Err(format!("missing sidecar files in {}", res.display()).into());
            }

            // Data uživatele mimo instalační složku (Program Files je read-only).
            let data_dir = std::env::var("LOCALAPPDATA")
                .map(|p| std::path::PathBuf::from(p).join("Vedit"))
                .unwrap_or_else(|_| res.join("data"));

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
                .current_dir(&res)
                .env("VEDIT_DATA", &data_dir)
                .env("VEDIT_FFMPEG", &ffmpeg)
                .env("VEDIT_FFPROBE", &ffprobe)
                .env("VEDIT_PYTHON", ""); // TTS/ASR sidecar není součástí instalátoru (viz README)

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let child = cmd.spawn().map_err(|e| format!("start API server: {e}"))?;
            *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
