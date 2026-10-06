use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::probe::MediaProbe;
use crate::process::{lower_priority, Kill, Registry};

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
    let token = registry.insert(job_id.clone(), child)?;

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
                // Runs on every exit, so a normal finish cannot leave a mark
                // behind. Token-checked: a stale exit never evicts a newer job
                // that reused this id.
                let was_cancelled = registry.finish(&job_id, token);
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

    registry.finish(&job_id, token);
    Err(format!("ffmpeg ended without reporting an exit code\n{}", tail.join("\n")))
}

#[tauri::command]
pub fn cancel_job(registry: State<'_, Registry>, job_id: String) -> Result<(), String> {
    // cancel() removes the job and records the intent under one lock, so
    // run_ffmpeg cannot see the exit before it knows why. With nothing running
    // it returns None and marks nothing: no ghost mark, and a second cancel
    // cannot erase the first one's.
    if let Some((token, child)) = registry.cancel(&job_id) {
        if let Err(e) = Kill::kill(child) {
            registry.unmark(token);
            return Err(e);
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

#[tauri::command]
pub fn copy_file(from: String, to: String) -> Result<(), String> {
    std::fs::copy(&from, &to).map(|_| ()).map_err(|e| format!("{from} -> {to}: {e}"))
}

/// The video codec and container of a file, read from `ffmpeg -i`.
///
/// ffprobe would be the obvious tool and is not shipped: it is a 78 MB binary
/// whose only remaining job is this one line, and ffmpeg already prints it.
///
/// Deliberately not put in the registry. The registry exists so that no
/// long-running render outlives the window; `-i` with no output reads the
/// header and exits in milliseconds, so there is nothing worth cancelling and
/// the process cannot be left running.
#[tauri::command]
pub async fn probe_media(app: AppHandle, path: String) -> Result<MediaProbe, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-hide_banner", "-i", &path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    // `-i` with no output file always exits non-zero; the stream listing is
    // still on stderr, which is what we came for. A `None` field means "could
    // not tell", and the caller converts rather than copies.
    Ok(crate::probe::media(&String::from_utf8_lossy(&output.stderr)))
}
