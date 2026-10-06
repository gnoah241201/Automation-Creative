use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::process::{lower_priority, Registry};

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    #[serde(rename = "jobId")]
    job_id: String,
    line: String,
}

/// Runs the bundled ffmpeg with argv built in the webview.
///
/// Rust does not inspect `args`. Everything about what to render was decided
/// by pure TypeScript that has tests; duplicating any of it here would give
/// the two halves a chance to disagree.
#[tauri::command]
pub async fn run_ffmpeg(
    app: AppHandle,
    registry: State<'_, Registry>,
    job_id: String,
    args: Vec<String>,
) -> Result<(), String> {
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    lower_priority(child.pid());
    // On a duplicate id the registry kills this child itself and refuses it.
    registry.insert(job_id.clone(), child)?;

    // ffmpeg writes progress to stderr, so the tail doubles as the error
    // report: when it exits non-zero these are the lines that say why.
    let mut tail: Vec<String> = Vec::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                tail.push(line.clone());
                if tail.len() > 10 {
                    tail.remove(0);
                }
                let _ = app.emit(
                    "ffmpeg-progress",
                    ProgressPayload { job_id: job_id.clone(), line },
                );
            }
            CommandEvent::Terminated(payload) => {
                registry.take(&job_id);
                // Consumed on every exit so a normal finish cannot leave a
                // stale mark behind for a later run under the same id.
                let was_cancelled = registry.take_cancelled(&job_id);
                return match payload.code {
                    Some(0) => Ok(()),
                    _ if was_cancelled => Err("cancelled".to_string()),
                    Some(code) => Err(format!("ffmpeg exited with code {code}\n{}", tail.join("\n"))),
                    None => Err(format!("ffmpeg was terminated\n{}", tail.join("\n"))),
                };
            }
            _ => {}
        }
    }

    registry.take(&job_id);
    registry.take_cancelled(&job_id);
    Err(format!("ffmpeg ended without reporting an exit code\n{}", tail.join("\n")))
}

#[tauri::command]
pub fn cancel_job(registry: State<'_, Registry>, job_id: String) -> Result<(), String> {
    // Marked before the take and the kill: run_ffmpeg sees the exit the
    // instant the process dies, and must already know why. If nothing is
    // running under this id the mark is withdrawn, or it would outlive any
    // job and poison the next one that reuses the id.
    registry.mark_cancelled(&job_id);
    match registry.take(&job_id) {
        Some(child) => {
            if let Err(e) = child.kill() {
                registry.take_cancelled(&job_id);
                return Err(e.to_string());
            }
        }
        None => {
            registry.take_cancelled(&job_id);
        }
    }
    Ok(())
}

/// Bare filenames in a folder. The webview compares them against the names it
/// is about to write, so it needs names, not paths.
#[tauri::command]
pub fn list_files(folder: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&folder).map_err(|e| format!("{folder}: {e}"))?;
    let mut names = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            names.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    Ok(names)
}
