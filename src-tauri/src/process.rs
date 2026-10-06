use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

/// What the registry needs from a child: a way to end it. A trait so the
/// bookkeeping can be unit-tested without spawning a real process.
pub trait Kill {
    fn kill(self) -> Result<(), String>;
}

impl Kill for CommandChild {
    fn kill(self) -> Result<(), String> {
        CommandChild::kill(self).map_err(|e| e.to_string())
    }
}

/// Everything the registry knows, behind ONE lock. Marking a job cancelled and
/// removing it from `children` have to be a single step: with two locks, a
/// second cancel could withdraw the first one's mark, and an exit event could
/// run between the two halves.
struct State<C> {
    /// Running jobs: id -> (generation token, child).
    children: HashMap<String, (u64, C)>,
    /// Tokens of runs killed on purpose, so their non-zero exit reads as a
    /// cancel and not as a crash. ffmpeg cannot tell us the difference; only
    /// we know. Keyed by token, not id: a later run reusing the id is a
    /// different token and cannot inherit or consume this mark.
    cancelled: HashSet<u64>,
    next_token: u64,
}

impl<C> Default for State<C> {
    fn default() -> Self {
        State { children: HashMap::new(), cancelled: HashSet::new(), next_token: 0 }
    }
}

/// Every ffmpeg Tauri has spawned and not yet reaped.
///
/// The webview owns the queue, so Rust never decides what runs. It only has
/// to guarantee that nothing outlives the window: an orphaned ffmpeg holds
/// its output file open and keeps burning cores with nobody watching.
pub struct Jobs<C>(Mutex<State<C>>);

pub type Registry = Jobs<CommandChild>;

impl<C> Default for Jobs<C> {
    fn default() -> Self {
        Jobs(Mutex::new(State::default()))
    }
}

impl<C: Kill> Jobs<C> {
    fn lock(&self) -> std::sync::MutexGuard<'_, State<C>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a running child and returns the token that identifies this
    /// run. The caller keeps it and hands it back to `finish`.
    pub fn insert(&self, job_id: String, child: C) -> Result<u64, String> {
        let refused = {
            let mut s = self.lock();
            if s.children.contains_key(&job_id) {
                Some(child)
            } else {
                let token = s.next_token;
                s.next_token += 1;
                s.children.insert(job_id.clone(), (token, child));
                return Ok(token);
            }
        };
        // Replacing would drop the old child, and dropping one does not kill
        // the process -- it would become untracked, which is the exact thing
        // this registry exists to prevent. The new child is ours to dispose of
        // too, so it is killed here (outside the lock) before the refusal.
        if let Some(child) = refused {
            let _ = child.kill();
        }
        Err(format!("job {job_id} is already running"))
    }

    /// Removes the job and marks that run as cancelled in one step. Returns
    /// the child plus its token so the caller can kill it outside the lock,
    /// or None when nothing is running under this id: no mark is made, so
    /// there is nothing to withdraw and a repeated cancel cannot disturb the
    /// first one's mark.
    pub fn cancel(&self, job_id: &str) -> Option<(u64, C)> {
        let mut s = self.lock();
        let (token, child) = s.children.remove(job_id)?;
        s.cancelled.insert(token);
        Some((token, child))
    }

    /// Forgets a mark whose kill failed: the run was not actually cancelled.
    pub fn unmark(&self, token: u64) {
        self.lock().cancelled.remove(&token);
    }

    /// Called by the run when its process exits, whatever the exit code.
    /// Removes the registry entry only if it is still THIS run's (a stale exit
    /// event must not evict a newer job that reused the id), and consumes this
    /// run's cancel mark. True means this exit was a deliberate cancel.
    pub fn finish(&self, job_id: &str, token: u64) -> bool {
        let mut s = self.lock();
        if let Some((stored, _)) = s.children.get(job_id) {
            if *stored == token {
                s.children.remove(job_id);
            }
        }
        s.cancelled.remove(&token)
    }

    pub fn kill_all(&self) {
        let children = {
            let mut s = self.lock();
            std::mem::take(&mut s.children)
        };
        // The lock is released before TerminateProcess, so an event loop
        // calling cancel() or finish() cannot block behind a blocking kill.
        for (_, (_, child)) in children {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Stands in for a CommandChild and counts how many times it was killed.
    struct Fake(Arc<AtomicUsize>);
    impl Kill for Fake {
        fn kill(self) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    fn fake() -> (Fake, Arc<AtomicUsize>) {
        let kills = Arc::new(AtomicUsize::new(0));
        (Fake(kills.clone()), kills)
    }

    #[test]
    fn a_second_cancel_does_not_erase_the_first_ones_mark() {
        let jobs = Jobs::<Fake>::default();
        let (a, _) = fake();
        let token = jobs.insert("j".into(), a).unwrap();

        assert!(jobs.cancel("j").is_some());
        // The double-click: nothing left to cancel, and it must not disturb
        // the mark the first cancel left for run_ffmpeg to find.
        assert!(jobs.cancel("j").is_none());

        assert!(jobs.finish("j", token), "the exit must still read as a cancel");
    }

    #[test]
    fn a_stale_exit_does_not_evict_a_job_that_reused_the_id() {
        let jobs = Jobs::<Fake>::default();
        let (a, _) = fake();
        let token_a = jobs.insert("j".into(), a).unwrap();
        // A is cancelled; its exit event has not been handled yet.
        let (_, child_a) = jobs.cancel("j").unwrap();
        drop(child_a);

        let (b, b_kills) = fake();
        let token_b = jobs.insert("j".into(), b).unwrap();
        assert_ne!(token_a, token_b);

        // A's exit arrives late. It was a cancel, and it must leave B alone.
        assert!(jobs.finish("j", token_a));

        let (found_token, child_b) = jobs.cancel("j").expect("B must still be registered");
        assert_eq!(found_token, token_b);
        child_b.kill().unwrap();
        assert_eq!(b_kills.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_stale_exit_leaves_the_new_job_visible_to_kill_all() {
        let jobs = Jobs::<Fake>::default();
        let (a, _) = fake();
        let token_a = jobs.insert("j".into(), a).unwrap();
        jobs.cancel("j");
        let (b, b_kills) = fake();
        jobs.insert("j".into(), b).unwrap();
        jobs.finish("j", token_a);

        jobs.kill_all();
        assert_eq!(b_kills.load(Ordering::SeqCst), 1, "no orphan");
    }

    #[test]
    fn a_cancel_mark_belongs_to_its_run_not_to_the_id() {
        let jobs = Jobs::<Fake>::default();
        let (a, _) = fake();
        let token_a = jobs.insert("j".into(), a).unwrap();
        jobs.cancel("j");
        let (b, _) = fake();
        let token_b = jobs.insert("j".into(), b).unwrap();

        // B finishes first and on its own: it is not a cancel.
        assert!(!jobs.finish("j", token_b));
        // A's late exit still is.
        assert!(jobs.finish("j", token_a));
    }

    #[test]
    fn cancelling_nothing_leaves_no_mark_for_a_later_run() {
        let jobs = Jobs::<Fake>::default();
        assert!(jobs.cancel("ghost").is_none());
        let (a, _) = fake();
        let token = jobs.insert("ghost".into(), a).unwrap();
        assert!(!jobs.finish("ghost", token));
    }

    #[test]
    fn a_normal_finish_leaves_nothing_behind() {
        let jobs = Jobs::<Fake>::default();
        let (a, _) = fake();
        let t1 = jobs.insert("j".into(), a).unwrap();
        assert!(!jobs.finish("j", t1));
        // Late cancel after a normal finish: nothing to cancel, no mark.
        assert!(jobs.cancel("j").is_none());
        let (b, _) = fake();
        let t2 = jobs.insert("j".into(), b).unwrap();
        assert!(!jobs.finish("j", t2));
    }

    #[test]
    fn a_duplicate_id_is_refused_and_the_new_child_is_killed() {
        let jobs = Jobs::<Fake>::default();
        let (a, a_kills) = fake();
        jobs.insert("j".into(), a).unwrap();
        let (b, b_kills) = fake();
        assert!(jobs.insert("j".into(), b).is_err());
        assert_eq!(b_kills.load(Ordering::SeqCst), 1);
        assert_eq!(a_kills.load(Ordering::SeqCst), 0);
    }
}
