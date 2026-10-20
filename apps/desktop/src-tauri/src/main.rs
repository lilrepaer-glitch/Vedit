// Vedit desktop shell (Tauri).
// F0: kostra — okno hostuje React UI; API/MCP běží jako sidecar procesy
// (viz PLAN.md §6). Kompletní build vyžaduje Rust toolchain (není v CI sandboxu).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("chyba při spuštění Vedit aplikace");
}
