use std::collections::HashMap;
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

/// Every ffmpeg Tauri has spawned and not yet reaped.
///
/// The webview owns the queue, so Rust never decides what runs. It only has
/// to guarantee that nothing outlives the window: an orphaned ffmpeg holds
/// its output file open and keeps burning cores with nobody watching.
#[derive(Default)]
pub struct Registry(pub Mutex<HashMap<String, CommandChild>>);

impl Registry {
    pub fn insert(&self, job_id: String, child: CommandChild) {
        self.0.lock().unwrap().insert(job_id, child);
    }

    pub fn take(&self, job_id: &str) -> Option<CommandChild> {
        self.0.lock().unwrap().remove(job_id)
    }

    pub fn kill_all(&self) {
        let mut map = self.0.lock().unwrap();
        for (_, child) in map.drain() {
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
