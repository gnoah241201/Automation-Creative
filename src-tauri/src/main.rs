#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod probe;
mod process;

use tauri::{Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(process::Registry::default())
        .invoke_handler(tauri::generate_handler![
            commands::run_ffmpeg,
            commands::cancel_job,
            commands::list_files,
            commands::copy_file,
            commands::probe_media
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.state::<process::Registry>().kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
