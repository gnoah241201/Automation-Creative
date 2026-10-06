use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

/// Every ffmpeg Tauri has spawned and not yet reaped.
///
/// The webview owns the queue, so Rust never decides what runs. It only has
/// to guarantee that nothing outlives the window: an orphaned ffmpeg holds
/// its output file open and keeps burning cores with nobody watching.
#[derive(Default)]
pub struct Registry {
    children: Mutex<HashMap<String, CommandChild>>,
    /// Ids killed on purpose, so their non-zero exit reads as a cancel and not
    /// as a crash. ffmpeg cannot tell us the difference; only we know.
    cancelled: Mutex<HashSet<String>>,
}

impl Registry {
    pub fn insert(&self, job_id: String, child: CommandChild) -> Result<(), String> {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&job_id) {
            // Replacing would drop the old CommandChild, and dropping one does
            // not kill the process -- it would become untracked, which is the
            // exact thing this registry exists to prevent. The new child is
            // ours to dispose of too: dropping it would orphan it just the
            // same, so it is killed here before the error is returned.
            let _ = child.kill();
            return Err(format!("job {job_id} is already running"));
        }
        map.insert(job_id, child);
        Ok(())
    }

    pub fn take(&self, job_id: &str) -> Option<CommandChild> {
        self.children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(job_id)
    }

    /// Records that this id is about to be killed on purpose.
    pub fn mark_cancelled(&self, job_id: &str) {
        self.cancelled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job_id.to_string());
    }

    /// Forgets the mark and says whether it was there. Called on every exit,
    /// not only non-zero ones, so a job that finished normally cannot leave a
    /// stale id behind to be mistaken for a cancel on a later run.
    pub fn take_cancelled(&self, job_id: &str) -> bool {
        self.cancelled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(job_id)
    }

    pub fn kill_all(&self) {
        let map = {
            let mut guard = self.children.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *guard)
        };
        // The lock is released before TerminateProcess, so an event loop
        // calling take() cannot block behind a blocking kill.
        for (_, child) in map {
            let _ = child.kill();
        }
    }
}

/// Drops the process to BelowNormal so the host stays usable while a batch
/// runs. Measured on the web version: priority alone does not lower total CPU,
/// but it does stop the UI from stuttering.
#[cfg(windows)]
pub fn lower_priority(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if !handle.is_null() {
            SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
            CloseHandle(handle);
        }
    }
}
