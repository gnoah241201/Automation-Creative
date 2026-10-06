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

/// Makes sure the output folder exists and can really be written to.
///
/// Neither `runBatch` nor ffmpeg creates a missing output folder, and a folder
/// remembered from last week may be gone, so this creates it first. Then it
/// writes and removes a probe file, the only honest answer on Windows, where a
/// read-only attribute, a network share and a folder owned by another account
/// all fail differently.
#[tauri::command]
pub fn check_writable(folder: String) -> Result<(), String> {
    std::fs::create_dir_all(&folder).map_err(|e| format!("{folder}: {e}"))?;
    let probe = std::path::Path::new(&folder).join(".resize-write-probe");
    std::fs::write(&probe, b"1").map_err(|e| format!("{folder}: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Which of these paths are gone. A batch can sit on screen for an hour while
/// someone tidies the folder it was picked from.
#[tauri::command]
pub fn missing_paths(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| !std::path::Path::new(p).is_file()).collect()
}

/// Writes the PNG bytes sent as the raw request body to a fixed name in the
/// temp directory and returns the path.
///
/// The logo / CTA overlay is drawn on a canvas in the webview, so the bytes
/// start there and ffmpeg needs them as a file. The name is the caller's
/// (one per input/output ratio pair), so the folder stays bounded at ten small
/// files that are overwritten each run, instead of growing without end.
#[tauri::command]
pub fn write_temp_png(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_temp_png expects raw bytes".to_string());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .ok_or("missing x-file-name header")?;
    // A name, not a path: nothing here may reach outside the temp folder.
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
        return Err(format!("{name}: not a plain file name"));
    }
    let dir = std::env::temp_dir().join("resize-video-overlays");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("resize-video-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_missing_output_folder_is_created_not_reported_unwritable() {
        let dir = scratch("create").join("nested").join("out");
        assert!(check_writable(dir.to_string_lossy().to_string()).is_ok());
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn the_probe_file_does_not_outlive_the_check() {
        let dir = scratch("probe");
        std::fs::create_dir_all(&dir).unwrap();
        check_writable(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_that_cannot_exist_is_refused() {
        // A file where the folder should be: neither created nor written into.
        let file = scratch("blocked");
        std::fs::write(&file, b"x").unwrap();
        let err = check_writable(file.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains(file.to_string_lossy().as_ref()), "the error names the folder: {err}");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn only_the_paths_that_are_gone_come_back() {
        let dir = scratch("missing");
        std::fs::create_dir_all(&dir).unwrap();
        let here = dir.join("here.mp4");
        std::fs::write(&here, b"x").unwrap();
        let gone = dir.join("gone.mp4");
        let missing = missing_paths(vec![
            here.to_string_lossy().to_string(),
            gone.to_string_lossy().to_string(),
            dir.to_string_lossy().to_string(), // a folder is not a source file
        ]);
        assert_eq!(missing, vec![gone.to_string_lossy().to_string(), dir.to_string_lossy().to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
