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

/// The suffix a file carries while it is being written. A file with this suffix
/// is visibly not a deliverable, which is the point: if the process dies or is
/// killed, what is left behind cannot be mistaken for a finished output.
const PART_SUFFIX: &str = ".part";

fn part_path(final_path: &str) -> String {
    format!("{final_path}{PART_SUFFIX}")
}

/// Redirects an ffmpeg run's output to `<final>.part`.
///
/// ffmpeg's output is the last argument. When that is a `.mp4` path, returns
/// the argv with it replaced by the `.part` path (plus `-f mp4`, because
/// ffmpeg picks the muxer from the extension and `.part` names none) together
/// with both paths. Anything else is left alone: only mp4 outputs are produced
/// here, and guessing a muxer for another extension would be worse than writing
/// the final name directly.
fn redirect_output(args: &[String]) -> Option<(Vec<String>, String, String)> {
    let (last, rest) = args.split_last()?;
    if last.starts_with('-') || !last.to_ascii_lowercase().ends_with(".mp4") {
        return None;
    }
    let part = part_path(last);
    let mut redirected: Vec<String> = rest.to_vec();
    redirected.push("-f".to_string());
    redirected.push("mp4".to_string());
    redirected.push(part.clone());
    Some((redirected, last.clone(), part))
}

/// Deletes a `.part`, tolerating one that is not there. A killed process can
/// hold its output open for a moment after it is reported gone, so a refusal is
/// retried briefly before it is given up on.
fn remove_part(part: &str) {
    for attempt in 0..5 {
        match std::fs::remove_file(part) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 4 => std::thread::sleep(std::time::Duration::from_millis(40)),
            Err(_) => return,
        }
    }
}

/// Settles a `.part` once its writer has finished.
///
/// Success promotes it to the final name; anything else deletes it, so no run
/// that did not finish leaves a file at a name someone will upload. A rename
/// that fails (the destination is read-only, or open elsewhere) is a failed
/// run: the `.part` is removed and the error says why.
fn settle_part(succeeded: bool, final_path: &str, part: &str) -> Result<(), String> {
    if !succeeded {
        remove_part(part);
        return Ok(());
    }
    std::fs::rename(part, final_path).map_err(|e| {
        remove_part(part);
        format!("{part} -> {final_path}: {e}")
    })
}

/// Runs the bundled ffmpeg with argv built in the webview.
///
/// Rust does not inspect `args`. Everything about what to render was decided
/// by pure TypeScript that has tests; duplicating any of it here would give
/// the two halves a chance to disagree. The one exception is where the output
/// lands: it is written as `<name>.part` and renamed to `<name>` only when
/// ffmpeg exits 0, so a cancelled, failed or killed run never leaves a
/// truncated file under a real name. Doing it here, not in the webview, is what
/// covers a kill: nothing in the webview runs when the window is gone.
#[tauri::command]
pub async fn run_ffmpeg(
    app: AppHandle,
    registry: State<'_, Registry>,
    job_id: String,
    args: Vec<String>,
) -> Result<(), String> {
    let (args, finished) = match redirect_output(&args) {
        Some((redirected, final_path, part)) => (redirected, Some((final_path, part))),
        None => (args, None),
    };
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
                if let Some((final_path, part)) = &finished {
                    if let Err(message) = settle_part(payload.code == Some(0), final_path, part) {
                        return Err(message);
                    }
                }
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
    if let Some((_, part)) = &finished {
        remove_part(part);
    }
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

/// Copies via `<to>.part` and renames on success, so an interrupted copy never
/// leaves a truncated file at the destination's real name. It still replaces an
/// existing destination: the caller asked the person first.
#[tauri::command]
pub fn copy_file(from: String, to: String) -> Result<(), String> {
    let part = part_path(&to);
    if let Err(e) = std::fs::copy(&from, &part) {
        remove_part(&part);
        return Err(format!("{from} -> {to}: {e}"));
    }
    settle_part(true, &to, &part).map_err(|e| format!("{from} -> {e}"))
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

/// The largest overlay image accepted. A 1920x1080 PNG is a few megabytes at
/// most; this stops a bug or a hostile page from filling the temp folder.
const MAX_OVERLAY_BYTES: usize = 32 * 1024 * 1024;

/// A name that can only mean a file directly inside the folder it is joined to.
///
/// No separators of either kind, no drive or stream colon, no `..` anywhere
/// (stricter than it must be, so a name like `a..b` is refused too), and not
/// empty or `.`.
fn plain_name(name: &str) -> bool {
    !(name.is_empty()
        || name == "."
        || name.contains(['/', '\\', ':'])
        || name.contains(".."))
}

/// Writes the PNG bytes sent as the raw request body under the caller's name in
/// `<temp>/resize-video-overlays` and returns the path.
///
/// The logo / CTA overlay is drawn on a canvas in the webview, so the bytes
/// start there and ffmpeg needs them as a file. The command does not bound how
/// many files that folder holds; that is a property of the caller's naming. The
/// webview names one file per (source ratio, output ratio) pair, so the same
/// handful are overwritten on every run.
#[tauri::command]
pub fn write_temp_png(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_temp_png expects raw bytes".to_string());
    };
    if bytes.len() > MAX_OVERLAY_BYTES {
        return Err(format!("overlay is {} bytes, more than the {MAX_OVERLAY_BYTES} allowed", bytes.len()));
    }
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .ok_or("missing x-file-name header")?;
    // A name, not a path: nothing here may reach outside the temp folder.
    if !plain_name(name) {
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
    fn plain_names_are_accepted() {
        assert!(plain_name("overlay-16x9-to-9x16.png"));
        assert!(plain_name("a.png"));
    }

    #[test]
    fn a_name_that_could_leave_the_folder_is_refused() {
        for bad in ["", ".", "..", "../x.png", "a/b.png", "a\\b.png", "C:x.png", "x.png:stream", "a..b.png", "/abs.png"] {
            assert!(!plain_name(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_output_is_redirected_to_a_part_file_with_an_explicit_muxer() {
        let args: Vec<String> = ["-y", "-i", "in.mp4", "C:/out/a.mp4"].iter().map(|s| s.to_string()).collect();
        let (redirected, final_path, part) = redirect_output(&args).unwrap();
        assert_eq!(final_path, "C:/out/a.mp4");
        assert_eq!(part, "C:/out/a.mp4.part");
        assert_eq!(redirected, vec!["-y", "-i", "in.mp4", "-f", "mp4", "C:/out/a.mp4.part"]);
    }

    #[test]
    fn an_output_that_is_not_an_mp4_path_is_left_alone() {
        let nothing: Vec<String> = vec![];
        assert!(redirect_output(&nothing).is_none());
        let flag_last: Vec<String> = ["-i", "in.mp4", "-"].iter().map(|s| s.to_string()).collect();
        assert!(redirect_output(&flag_last).is_none());
        let other: Vec<String> = ["-i", "in.mp4", "out.mkv"].iter().map(|s| s.to_string()).collect();
        assert!(redirect_output(&other).is_none());
        let upper: Vec<String> = ["-i", "in.mp4", "OUT.MP4"].iter().map(|s| s.to_string()).collect();
        assert!(redirect_output(&upper).is_some(), "the extension check ignores case");
    }

    #[test]
    fn a_finished_run_promotes_the_part_file() {
        let dir = scratch("settle-ok");
        std::fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("a.mp4").to_string_lossy().to_string();
        let part = part_path(&final_path);
        std::fs::write(&part, b"complete").unwrap();
        settle_part(true, &final_path, &part).unwrap();
        assert_eq!(std::fs::read(&final_path).unwrap(), b"complete");
        assert!(!std::path::Path::new(&part).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_that_did_not_finish_leaves_nothing_at_the_final_name() {
        let dir = scratch("settle-fail");
        std::fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("a.mp4").to_string_lossy().to_string();
        let part = part_path(&final_path);
        std::fs::write(&part, b"trunc").unwrap();
        settle_part(false, &final_path, &part).unwrap();
        assert!(!std::path::Path::new(&final_path).exists(), "no truncated file under the real name");
        assert!(!std::path::Path::new(&part).exists(), "and no part file left either");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_run_does_not_touch_an_earlier_good_file() {
        // The retry case: last run's good file is still there while this one dies.
        let dir = scratch("settle-keep");
        std::fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("a.mp4").to_string_lossy().to_string();
        std::fs::write(&final_path, b"earlier good").unwrap();
        let part = part_path(&final_path);
        std::fs::write(&part, b"trunc").unwrap();
        settle_part(false, &final_path, &part).unwrap();
        assert_eq!(std::fs::read(&final_path).unwrap(), b"earlier good");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_part_file_is_not_an_error_to_remove() {
        let dir = scratch("settle-missing");
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("never.mp4.part").to_string_lossy().to_string();
        remove_part(&part);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_file_leaves_no_part_file_and_lands_complete() {
        let dir = scratch("copy-ok");
        std::fs::create_dir_all(&dir).unwrap();
        let from = dir.join("src.mp4");
        std::fs::write(&from, b"original bytes").unwrap();
        let to = dir.join("dst.mp4");
        copy_file(from.to_string_lossy().to_string(), to.to_string_lossy().to_string()).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"original bytes");
        assert!(!dir.join("dst.mp4.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_that_fails_leaves_nothing_behind() {
        let dir = scratch("copy-fail");
        std::fs::create_dir_all(&dir).unwrap();
        let to = dir.join("dst.mp4");
        let err = copy_file(dir.join("missing.mp4").to_string_lossy().to_string(), to.to_string_lossy().to_string());
        assert!(err.is_err());
        assert!(!to.exists());
        assert!(!dir.join("dst.mp4.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_over_an_existing_file_replaces_it_whole() {
        let dir = scratch("copy-replace");
        std::fs::create_dir_all(&dir).unwrap();
        let from = dir.join("src.mp4");
        std::fs::write(&from, b"new").unwrap();
        let to = dir.join("dst.mp4");
        std::fs::write(&to, b"old and longer").unwrap();
        copy_file(from.to_string_lossy().to_string(), to.to_string_lossy().to_string()).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&dir);
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
