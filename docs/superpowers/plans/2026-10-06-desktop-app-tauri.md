# Resize Video Desktop (Tauri 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ResizeVideo1 web app into a single Windows `.exe` that reads videos where they sit, renders them with a bundled ffmpeg, and writes the results straight into a folder the user picks.

**Architecture:** Two halves. The webview (TypeScript + React) owns every decision — output derivation, naming, spec building, ffmpeg argv construction, the render queue — and all of it is pure, testable with `node:test`. Rust owns everything that touches the OS: six thin commands (pick files, pick folder, pick image, list a folder, run ffmpeg, cancel) plus a process registry that kills children when the window closes. There is no HTTP server.

**Tech Stack:** Tauri 2, Rust (MSVC toolchain), React 19, Vite 6, TypeScript, `node:test` + `tsx`, bundled `ffmpeg.exe` as a Tauri sidecar.

**Spec:** `docs/superpowers/specs/2026-10-06-desktop-app-tauri-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Platform:** Windows x64 only. Target triple `x86_64-pc-windows-msvc`.
- **Tauri:** v2.x. Plugins: `tauri-plugin-dialog`, `tauri-plugin-shell`, `tauri-plugin-opener`.
- **ffmpeg:** bundled as a sidecar at `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`. **`ffprobe` is not shipped.** Anything that needs codec info runs `ffmpeg -i <file>` and reads stderr.
- **Ratios:** exactly `9:16, 16:9, 4:5, 2:3, 1:1`. No others, ever.
- **Cut mode lengths:** `6, 10, 12, 15, 30, 60, 90, 120`. A tier is offered only when `d > T`. Each ratio also gets a full-length output **unless** the longest offered cut is within `1` second of the source.
- **Speed-up mode lengths:** `15, 30`. A tier is offered only when `d > T + 0.5`. The full-length output always exists and is the one composite.
- **One composite per ratio.** Cut mode renders the longest and trims the rest with `-t N -c copy`. Speed-up mode renders the full length and retimes the rest.
- **Filenames** come from `buildOutputFilename(meta, ratio, duration)` only. Never hand-built.
- **Settings** live in `localStorage`.
- **Tests:** `npm test` runs `node --import tsx --test --test-concurrency=1`. It must pass at the end of every task.
- **Commits:** every task ends with a commit. Message body explains *why*, not *what*.
- **Co-author line** on every commit: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**New — Rust:**

| File | Responsibility |
|---|---|
| `src-tauri/src/main.rs` | App setup, plugin registration, window-close hook |
| `src-tauri/src/commands.rs` | The six `#[tauri::command]` functions, nothing else |
| `src-tauri/src/process.rs` | Process registry, Windows priority + affinity |
| `src-tauri/tauri.conf.json` | Window, sidecar, asset-protocol scope |

**New — TypeScript:**

| File | Responsibility |
|---|---|
| `src/bridge/tauri.ts` | The only module that calls `invoke`. Mockable seam for tests |
| `src/core/progressParse.ts` | `time=` → seconds, extracted from `renderRunner.ts` |
| `src/core/renderPlan.ts` | Build the job list; order parents before children |
| `src/core/renderQueue.ts` | Run N jobs at a time, honouring dependencies |
| `src/core/outputCollision.ts` | Which planned filenames already exist on disk |
| `src/core/batchSources.ts` | Picked paths → `ResizeBatchSource[]`, from `batchUpload.ts` |
| `src/core/originalCopy.ts` | Decide copy-vs-convert for the bundled original |
| `src/core/settings.ts` | Read/write settings in `localStorage` |

**Moved into `src/core/` (unchanged logic, tests come along):**
`outputDerivation.ts` · `buildCommand.ts` · `sourceNormalize.ts` · `validation.ts` · `batchOutputs.ts` · `batchNaming.ts` · `fgDuration.ts` · `precomposedAnchor.ts` · `overlay.ts` · `naming/*` · `naming.ts`

**Deleted:** `server/` · `src/composer/` · `src/library/` · `src/naming/namingHistory.ts` · Docker, nginx, prometheus, grafana, deploy scripts · the two `.tar.gz` archives · every `*.sync-conflict-*`

---

## Task 1: Tauri shell showing the existing UI

Scaffolding only. No business logic moves yet. The deliverable is a window.

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/build.rs`, `src-tauri/.gitignore`
- Modify: `package.json`, `vite.config.ts`, `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `npm run tauri dev` opens a desktop window rendering `src/main.tsx`

- [ ] **Step 1: Install the Rust toolchain**

Run in PowerShell, then restart the shell:

```powershell
winget install --id Rustlang.Rustup -e
rustup default stable-x86_64-pc-windows-msvc
```

Verify: `cargo --version` prints a version. If it fails, install "Desktop development with C++" from the Visual Studio Build Tools installer — Tauri needs the MSVC linker.

- [ ] **Step 2: Add the Tauri dependencies**

```bash
npm install --save-dev @tauri-apps/cli@^2
npm install @tauri-apps/api@^2 @tauri-apps/plugin-dialog@^2 @tauri-apps/plugin-opener@^2 @tauri-apps/plugin-shell@^2
```

- [ ] **Step 3: Scaffold `src-tauri`**

Create `src-tauri/Cargo.toml`:

```toml
[package]
name = "resize-video"
version = "2.0.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
tauri-plugin-opener = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
windows-sys = { version = "0.59", features = ["Win32_System_Threading", "Win32_Foundation"] }
```

Create `src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

Create `src-tauri/.gitignore`:

```
/target
/binaries
```

- [ ] **Step 4: Write `tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Resize Video",
  "version": "2.0.0",
  "identifier": "com.bravestars.resizevideo",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:8080",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "Resize Video",
        "width": 1100,
        "height": 820,
        "minWidth": 900,
        "minHeight": 600,
        "dragDropEnabled": true
      }
    ],
    "security": {
      "csp": null,
      "assetProtocol": { "enable": true, "scope": ["**"] }
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"]
  }
}
```

`assetProtocol.scope: ["**"]` is what lets the preview `<video>` read a file anywhere on the user's disk. The user picks the file through a native dialog, so there is no untrusted path here.

- [ ] **Step 5: Write `main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`windows_subsystem = "windows"` in release is what stops a black console window appearing behind the app.

- [ ] **Step 6: Add the npm scripts**

In `package.json`, add to `"scripts"`:

```json
"tauri": "tauri",
"app:dev": "tauri dev",
"app:build": "tauri build"
```

- [ ] **Step 7: Add an icon**

Tauri needs `src-tauri/icons/icon.ico`. Generate placeholders from any square PNG:

```bash
npx @tauri-apps/cli icon path/to/square.png
```

- [ ] **Step 8: Run it**

Run: `npm run app:dev`
Expected: a native window opens showing the current Resize UI. The backend is not running, so any API call fails — that is correct at this stage.

- [ ] **Step 9: Commit**

```bash
git add src-tauri package.json package-lock.json .gitignore
git commit -m "$(cat <<'EOF'
feat(desktop): open the existing UI in a Tauri window

The shell comes first so every later task has somewhere to run. No logic
moves yet: this window still talks to the Express server, which is why
its API calls fail until the queue moves into the webview.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Run the bundled ffmpeg from Rust

**Files:**
- Create: `src-tauri/src/process.rs`, `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`
- Create: `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` (copied, not committed)

**Interfaces:**
- Consumes: Task 1's shell
- Produces:
  - `invoke('run_ffmpeg', { jobId: string, args: string[] }) -> Promise<void>` — resolves on exit code 0, rejects with the last stderr lines otherwise
  - `invoke('cancel_job', { jobId: string }) -> Promise<void>`
  - Event `ffmpeg-progress` with payload `{ jobId: string, line: string }`

- [ ] **Step 1: Copy ffmpeg into place**

```bash
mkdir -p src-tauri/binaries
cp node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe
```

The target-triple suffix is required — Tauri resolves sidecars by it.

- [ ] **Step 2: Declare the sidecar**

In `tauri.conf.json`, inside `"bundle"`:

```json
"externalBin": ["binaries/ffmpeg"]
```

- [ ] **Step 3: Write the process registry**

Create `src-tauri/src/process.rs`:

```rust
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
```

- [ ] **Step 4: Write the command**

Create `src-tauri/src/commands.rs`:

```rust
use tauri::{AppHandle, Emitter, Manager, State};
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
    registry.insert(job_id.clone(), child);

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
                return match payload.code {
                    Some(0) => Ok(()),
                    Some(code) => Err(format!("ffmpeg exited with code {code}\n{}", tail.join("\n"))),
                    None => Err(format!("ffmpeg was terminated\n{}", tail.join("\n"))),
                };
            }
            _ => {}
        }
    }

    registry.take(&job_id);
    Err(format!("ffmpeg ended without reporting an exit code\n{}", tail.join("\n")))
}

#[tauri::command]
pub fn cancel_job(registry: State<'_, Registry>, job_id: String) -> Result<(), String> {
    if let Some(child) = registry.take(&job_id) {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

- [ ] **Step 5: Register state, command, and the close hook**

Replace the body of `src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
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
            commands::cancel_job
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.state::<process::Registry>().kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: Verify end to end by hand**

Run `npm run app:dev`, open devtools (right-click → Inspect), and run:

```js
const { invoke } = await import('@tauri-apps/api/core')
await invoke('run_ffmpeg', {
  jobId: 'smoke',
  args: ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
         'C:\\Users\\Public\\tauri-smoke.mp4']
})
```

Expected: resolves, and `C:\Users\Public\tauri-smoke.mp4` exists and plays.

- [ ] **Step 7: Verify the kill-on-close**

Start a long render (`duration=600`), then close the window. In PowerShell:

```powershell
Get-Process ffmpeg -ErrorAction SilentlyContinue
```

Expected: nothing. If an ffmpeg survives, `kill_all` is not wired to the right event.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
feat(desktop): run the bundled ffmpeg and never outlive the window

Rust deliberately does not read the argv it is handed. What to render is
decided by pure TypeScript that has tests; re-deciding any of it here
would give the two halves room to disagree.

The registry exists for the bug the web version hit three times: a render
that survived its parent kept a core busy and a port held, and the only
way to find it was to look up who owned the port. Closing the window now
reaps the children.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Progress parsing as a tested unit

`renderRunner.ts` already parses `time=` — it just isn't exported or tested on its own. Extract it before deleting the server.

**Files:**
- Create: `src/core/progressParse.ts`
- Create: `test/progress-parse.test.ts`
- Reference: `server/services/renderRunner.ts:47-60`

**Interfaces:**
- Produces:
  - `parseFfmpegSeconds(line: string): number | null`
  - `progressPercent(line: string, totalSeconds: number): number | null`

- [ ] **Step 1: Write the failing test**

Create `test/progress-parse.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFfmpegSeconds, progressPercent } from '../src/core/progressParse.ts';

test('a normal ffmpeg status line yields its timestamp in seconds', () => {
  const line = 'frame=  360 fps= 30 q=28.0 size=    1024kB time=00:00:12.34 bitrate= 679.8kbits/s speed=1.02x';
  assert.equal(parseFfmpegSeconds(line), 12.34);
});

test('hours and minutes both count', () => {
  assert.equal(parseFfmpegSeconds('time=01:02:03.00'), 3723);
});

test('a line without a timestamp yields null rather than zero', () => {
  // Zero would read as "0% done" and march the bar backwards on every
  // banner line ffmpeg prints before it starts working.
  assert.equal(parseFfmpegSeconds('Press [q] to stop, [?] for help'), null);
});

test('a malformed timestamp yields null', () => {
  assert.equal(parseFfmpegSeconds('time=::'), null);
});

test('percent is the timestamp over the total', () => {
  assert.equal(progressPercent('time=00:00:15.00', 30), 50);
});

test('percent never exceeds 100 even when ffmpeg overshoots the probe', () => {
  assert.equal(progressPercent('time=00:00:31.00', 30), 100);
});

test('percent is null when the total is unknown or useless', () => {
  for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(progressPercent('time=00:00:15.00', total), null, `total ${total}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/progress-parse.test.ts`
Expected: FAIL — cannot find module `../src/core/progressParse.ts`

- [ ] **Step 3: Implement**

Create `src/core/progressParse.ts`:

```ts
/**
 * Reads ffmpeg's progress out of the stderr lines Rust forwards.
 *
 * Lifted from the web version's `renderRunner.ts`, where it was a private
 * helper with no test of its own. It is the only thing standing between a
 * stderr stream and a progress bar, so it gets to be its own unit now.
 */

const TIMECODE = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** Seconds into the render, or null when the line carries no timestamp. */
export const parseFfmpegSeconds = (line: string): number | null => {
  const match = line.match(TIMECODE);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? seconds : null;
};

/**
 * Null means "no number to show" — the caller keeps the bar where it was
 * rather than resetting it, which is what returning 0 would do.
 */
export const progressPercent = (line: string, totalSeconds: number): number | null => {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  const seconds = parseFfmpegSeconds(line);
  if (seconds === null) return null;
  return Math.min(100, (seconds / totalSeconds) * 100);
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test test/progress-parse.test.ts`
Expected: 7 passing

- [ ] **Step 5: Commit**

```bash
git add src/core/progressParse.ts test/progress-parse.test.ts
git commit -m "$(cat <<'EOF'
feat(core): give progress parsing a test before the server goes

This logic already existed inside renderRunner as a private helper with
no test. It is the only thing between a stderr stream and a progress bar,
and it is about to be the only copy, so it gets to be its own unit.

Returning null rather than 0 for a line with no timestamp is the point:
ffmpeg prints a banner before it starts, and 0 would march the bar
backwards on every one of those lines.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: The bridge — the only module that calls `invoke`

Every later task talks to Rust through this, so tests can replace it wholesale.

**Files:**
- Create: `src/bridge/tauri.ts`
- Create: `test/bridge.test.ts`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Produces:
  - `pickVideos(): Promise<string[]>`
  - `pickFolder(): Promise<string | null>`
  - `pickImage(): Promise<string | null>`
  - `listFiles(folder: string): Promise<string[]>` — bare filenames, not paths
  - `runFfmpeg(jobId: string, args: string[]): Promise<void>`
  - `cancelJob(jobId: string): Promise<void>`
  - `onProgress(fn: (jobId: string, line: string) => void): Promise<() => void>`
  - `fileUrl(path: string): string`
  - `revealFolder(path: string): Promise<void>`
  - `setBridge(fake: Partial<Bridge>): void` — test seam
  - `getBridge(): Bridge`

- [ ] **Step 1: Add the Rust side of `list_files`**

Append to `src-tauri/src/commands.rs`:

```rust
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
```

Add `commands::list_files` to the `generate_handler!` list in `main.rs`.

- [ ] **Step 2: Write the failing test**

Create `test/bridge.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { getBridge, setBridge } from '../src/bridge/tauri.ts';

test('a fake replaces only the calls it defines', async () => {
  const calls: string[] = [];
  setBridge({
    runFfmpeg: async (jobId) => { calls.push(jobId); },
  });

  await getBridge().runFfmpeg('job-1', ['-y']);
  assert.deepEqual(calls, ['job-1']);
});

test('fileUrl is synchronous so a preview can use it during render', () => {
  setBridge({ fileUrl: (path) => `fake://${path}` });
  assert.equal(getBridge().fileUrl('D:\\clip.mp4'), 'fake://D:\\clip.mp4');
});

test('an unfaked call outside Tauri fails loudly instead of silently doing nothing', async () => {
  setBridge({});
  await assert.rejects(
    () => getBridge().pickVideos(),
    /outside a Tauri window/,
  );
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test test/bridge.test.ts`
Expected: FAIL — cannot find module `../src/bridge/tauri.ts`

- [ ] **Step 4: Implement**

Create `src/bridge/tauri.ts`:

```ts
/**
 * The single seam between decisions and the machine.
 *
 * Nothing else in `src/` imports `@tauri-apps/*`. That keeps every other
 * module runnable under plain Node, which is why the test suite needs no
 * browser and no window.
 */

export interface Bridge {
  pickVideos(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pickImage(): Promise<string | null>;
  listFiles(folder: string): Promise<string[]>;
  runFfmpeg(jobId: string, args: string[]): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  onProgress(fn: (jobId: string, line: string) => void): Promise<() => void>;
  fileUrl(path: string): string;
  revealFolder(path: string): Promise<void>;
}

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

const notInTauri = (name: string) => async (): Promise<never> => {
  throw new Error(`${name} was called outside a Tauri window. Use setBridge() in tests.`);
};

const real: Bridge = {
  async pickVideos() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: true, filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }] });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  async pickFolder() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  },
  async pickImage() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: false, filters: [{ name: 'Image', extensions: IMAGE_EXTENSIONS }] });
    return typeof picked === 'string' ? picked : null;
  },
  async listFiles(folder) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string[]>('list_files', { folder });
  },
  async runFfmpeg(jobId, args) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<void>('run_ffmpeg', { jobId, args });
  },
  async cancelJob(jobId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<void>('cancel_job', { jobId });
  },
  async onProgress(fn) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<{ jobId: string; line: string }>(
      'ffmpeg-progress',
      (event) => fn(event.payload.jobId, event.payload.line),
    );
  },
  fileUrl(path) {
    // Synchronous on purpose: a <video> src cannot wait on a promise.
    // @ts-expect-error -- injected by Tauri at runtime
    return window.__TAURI__.core.convertFileSrc(path);
  },
  async revealFolder(path) {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    return revealItemInDir(path);
  },
};

const fallback: Bridge = {
  pickVideos: notInTauri('pickVideos'),
  pickFolder: notInTauri('pickFolder'),
  pickImage: notInTauri('pickImage'),
  listFiles: notInTauri('listFiles'),
  runFfmpeg: notInTauri('runFfmpeg'),
  cancelJob: notInTauri('cancelJob'),
  onProgress: notInTauri('onProgress'),
  fileUrl: (path) => path,
  revealFolder: notInTauri('revealFolder'),
};

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let current: Bridge = inTauri ? real : fallback;

export const getBridge = (): Bridge => current;

/** Replaces part of the bridge for a test. Unlisted calls keep failing loudly. */
export const setBridge = (fake: Partial<Bridge>): void => {
  current = { ...(inTauri ? real : fallback), ...fake };
};
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx tsx --test test/bridge.test.ts`
Expected: 3 passing

- [ ] **Step 6: Commit**

```bash
git add src/bridge test/bridge.test.ts src-tauri/src
git commit -m "$(cat <<'EOF'
feat(bridge): put every OS call behind one replaceable module

Nothing else in src/ imports @tauri-apps. That is what keeps the rest of
the app runnable under plain Node, so the suite needs no browser and no
window to test the parts that decide things.

Unfaked calls throw rather than return undefined: a silent no-op in a
test reads as a passing render that wrote nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Move the pure modules into `src/core/`

Mechanical, and the existing suite is the proof. Do it before touching logic so later diffs are readable.

**Files:**
- Move: `server/ffmpeg/buildCommand.ts` → `src/core/buildCommand.ts`
- Move: `server/services/sourceNormalize.ts` → `src/core/sourceNormalize.ts`
- Move: `server/services/validation.ts` → `src/core/validation.ts`
- Move: `shared/naming.ts` → `src/core/naming.ts`
- Move: `shared/precomposedAnchor.ts` → `src/core/precomposedAnchor.ts`
- Move: `shared/render-contract.ts` → `src/core/contract.ts`
- Move: `src/render/outputDerivation.ts` → `src/core/outputDerivation.ts`
- Move: `src/render/batchOutputs.ts` → `src/core/batchOutputs.ts`
- Move: `src/render/batchNaming.ts` → `src/core/batchNaming.ts`
- Move: `src/render/fgDuration.ts` → `src/core/fgDuration.ts`
- Move: `src/render/overlay.ts`, `overlayDefaults.ts`, `librarySources.ts` → `src/core/`
- Move: `src/naming/namingConfig.ts`, `versionSequence.ts` → `src/core/naming/`
- Modify: every test under `test/` that imports the moved paths

**Interfaces:**
- Consumes: nothing new
- Produces: all previously exported names, at `src/core/…`

- [ ] **Step 1: Delete the sync-conflict files first**

They are Syncthing leftovers and two of them are test files the runner will try to execute.

```bash
cd /d/Videcode/ResizeVideo1
git clean -n -- '*sync-conflict*'   # look at the list first
rm -f $(git ls-files --others --exclude-standard | grep sync-conflict)
```

- [ ] **Step 2: Record the current test count**

Run: `npm test 2>&1 | tail -5`
Write down the pass count. It must not drop in this task.

- [ ] **Step 3: Move the files with git so history follows**

```bash
mkdir -p src/core/naming
git mv server/ffmpeg/buildCommand.ts src/core/buildCommand.ts
git mv server/services/sourceNormalize.ts src/core/sourceNormalize.ts
git mv server/services/validation.ts src/core/validation.ts
git mv shared/naming.ts src/core/naming.ts
git mv shared/precomposedAnchor.ts src/core/precomposedAnchor.ts
git mv shared/render-contract.ts src/core/contract.ts
git mv src/render/outputDerivation.ts src/core/outputDerivation.ts
git mv src/render/batchOutputs.ts src/core/batchOutputs.ts
git mv src/render/batchNaming.ts src/core/batchNaming.ts
git mv src/render/fgDuration.ts src/core/fgDuration.ts
git mv src/render/overlay.ts src/core/overlay.ts
git mv src/render/overlayDefaults.ts src/core/overlayDefaults.ts
git mv src/render/librarySources.ts src/core/librarySources.ts
git mv src/naming/namingConfig.ts src/core/naming/namingConfig.ts
git mv src/naming/versionSequence.ts src/core/naming/versionSequence.ts
```

- [ ] **Step 4: Fix imports until the type-checker is quiet**

Run: `npx tsc --noEmit`

Fix each path it reports. `src/core/buildCommand.ts` loses its `EncoderMode` import from `encoderConfig.ts` — that file stays in `server/` and dies in Task 15, so inline the type instead:

```ts
export type EncoderMode = 'libx264' | 'h264_nvenc';
```

Put it at the top of `src/core/buildCommand.ts` and drop the import.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: the same pass count as Step 2. A lower number means an import went to the wrong place, not that a test became invalid.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(core): gather the pure modules before the server is deleted

These files never touched a socket or the disk; they only lived under
server/ because that is where the process that called them ran. Moving
them first keeps the deletion commit readable as a deletion instead of a
rewrite.

The suite is the proof: same pass count before and after.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Both length modes in one derivation

The uncommitted rewrite on disk swapped cut for speed-up. Keep both, behind a mode.

**Files:**
- Modify: `src/core/outputDerivation.ts`
- Modify: `test/output-derivation.test.ts`
- Create: `test/output-derivation-modes.test.ts`

**Interfaces:**
- Produces:
  - `type LengthMode = 'cut' | 'speed'`
  - `CUT_SECONDS: readonly number[]`, `SPEED_SECONDS: readonly number[]`
  - `deriveOutputs(inputRatio: InputRatio, fgDuration: number | undefined, mode: LengthMode): OutputConfig[]`
  - `OutputConfig` gains `trimFrom?: string` alongside the existing `speedFrom?: string`. A cut child sets `trimFrom`; a speed child sets `speedFrom`. Exactly one, never both.
  - `src/core/batchOutputs.ts` gains the same third argument throughout: `deriveSourceOutputs(source, mode)`, `deriveBatchOutputCatalog(sources, mode)`, `selectSourceOutputs(source, selectedIds, mode)`

- [ ] **Step 1: Write the failing test**

Create `test/output-derivation-modes.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUT_SECONDS, SPEED_SECONDS, RATIOS, deriveOutputs,
} from '../src/core/outputDerivation.ts';

const ids = (outputs: ReturnType<typeof deriveOutputs>) => outputs.map((o) => o.id);
const forRatio = (outputs: ReturnType<typeof deriveOutputs>, ratio: string) =>
  outputs.filter((o) => o.ratio === ratio);

test('the two tables are what the spec fixes them at', () => {
  assert.deepEqual([...CUT_SECONDS], [6, 10, 12, 15, 30, 60, 90, 120]);
  assert.deepEqual([...SPEED_SECONDS], [15, 30]);
});

test('cut mode offers a tier as soon as the source runs past it', () => {
  assert.equal(ids(deriveOutputs('9:16', 30, 'cut')).includes('9:16-30s'), false);
  assert.ok(ids(deriveOutputs('9:16', 30.1, 'cut')).includes('9:16-30s'));
});

test('speed mode keeps half a second of margin so two outputs cannot share a name', () => {
  assert.equal(ids(deriveOutputs('9:16', 30.4, 'speed')).includes('9:16-30s'), false);
  assert.ok(ids(deriveOutputs('9:16', 31, 'speed')).includes('9:16-30s'));
});

test('a cut child trims, a speed child retimes, never both', () => {
  const cut = forRatio(deriveOutputs('9:16', 200, 'cut'), '9:16').filter((o) => o.duration);
  for (const output of cut) {
    assert.ok(output.trimFrom, `${output.id} must trim`);
    assert.equal(output.speedFrom, undefined, `${output.id} must not retime`);
  }

  const speed = forRatio(deriveOutputs('9:16', 200, 'speed'), '9:16').filter((o) => o.duration);
  for (const output of speed) {
    assert.ok(output.speedFrom, `${output.id} must retime`);
    assert.equal(output.trimFrom, undefined, `${output.id} must not trim`);
  }
});

test('either mode composites each ratio exactly once', () => {
  for (const mode of ['cut', 'speed'] as const) {
    for (const duration of [12, 20, 45, 200]) {
      const rendered = deriveOutputs('9:16', duration, mode).filter((o) => !o.trimFrom && !o.speedFrom);
      assert.equal(rendered.length, RATIOS.length, `${mode} at d=${duration}`);
    }
  }
});

test('cut mode drops the full-length output when the longest cut all but covers it', () => {
  // 120.5s source: the 120s cut is within a second, so a separate full-length
  // output would be the same file under a second name.
  const full = forRatio(deriveOutputs('9:16', 120.5, 'cut'), '9:16').filter((o) => o.duration === undefined);
  assert.equal(full.length, 0);

  // 130s source: two seconds of the video live only in the full-length output.
  const kept = forRatio(deriveOutputs('9:16', 130, 'cut'), '9:16').filter((o) => o.duration === undefined);
  assert.equal(kept.length, 1);
});

test('speed mode always keeps the full-length output, it is the composite', () => {
  for (const duration of [12, 30.4, 120.5, 200]) {
    const full = forRatio(deriveOutputs('9:16', duration, 'speed'), '9:16')
      .filter((o) => o.duration === undefined);
    assert.equal(full.length, 1, `d=${duration}`);
    assert.equal(full[0].speedFrom, undefined);
  }
});

test('an unknown duration offers one composite per ratio in either mode', () => {
  for (const mode of ['cut', 'speed'] as const) {
    const outputs = deriveOutputs('16:9', undefined, mode);
    assert.equal(outputs.length, RATIOS.length);
    assert.equal(outputs.some((o) => o.duration !== undefined), false);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/output-derivation-modes.test.ts`
Expected: FAIL — `CUT_SECONDS` is not exported, and `deriveOutputs` takes two arguments.

- [ ] **Step 3: Implement**

Rewrite `src/core/outputDerivation.ts`:

```ts
import { InputRatio, AspectRatio } from './contract';

/** Lengths a cut output can take. A cut keeps the first N seconds. */
export const CUT_SECONDS = [6, 10, 12, 15, 30, 60, 90, 120] as const;

/**
 * Lengths a speed-up output can take.
 *
 * A speed-up is the *whole* video retimed to end at N seconds, so nothing is
 * left out — which is the point. A cut throws away everything after the mark,
 * and in an ad the payoff usually sits at the end.
 */
export const SPEED_SECONDS = [15, 30] as const;

/** Listed in preview order. */
export const RATIOS = ['9:16', '16:9', '4:5', '2:3', '1:1'] as const;

export type LengthMode = 'cut' | 'speed';

export interface OutputConfig {
  id: string;
  ratio: AspectRatio;
  /** undefined means the whole video at its own pace. */
  duration?: number;
  label: string;
  /** Set on a cut child: the id of the output it trims with `-c copy`. */
  trimFrom?: string;
  /** Set on a speed child: the id of the output it retimes. */
  speedFrom?: string;
  showPreview?: boolean;
}

/**
 * How much longer than a tier a source must run for speed mode to offer it.
 *
 * `buildOutputFilename` rounds, so without the margin a 30.2s source would
 * name its full-length output `_30s` as well — two different files under one
 * name. It also stops a 1.01x "speed-up" that is the same file twice.
 */
const SPEED_MARGIN_SECONDS = 0.5;

/** How close the longest cut has to be before a separate full-length is noise. */
const FULL_LENGTH_TOLERANCE_SECONDS = 1;

const usable = (d: number | undefined): d is number => d !== undefined && Number.isFinite(d) && d > 0;

const activeTiers = (mode: LengthMode, fgDuration: number | undefined): number[] => {
  if (!usable(fgDuration)) return [];
  return mode === 'cut'
    ? CUT_SECONDS.filter((seconds) => fgDuration > seconds)
    : SPEED_SECONDS.filter((seconds) => fgDuration > seconds + SPEED_MARGIN_SECONDS);
};

/**
 * Cut mode drops the full-length output when the longest cut all but covers
 * the source; speed mode never does, because the full length is the composite
 * every retimed output is built from.
 */
const needsFullLength = (mode: LengthMode, fgDuration: number | undefined, tiers: number[]): boolean => {
  if (mode === 'speed') return true;
  if (!usable(fgDuration)) return true;
  if (tiers.length === 0) return true;
  return fgDuration - tiers[tiers.length - 1] > FULL_LENGTH_TOLERANCE_SECONDS;
};

const label = (ratio: AspectRatio, mode: LengthMode, seconds?: number): string => {
  if (seconds === undefined) return `Output: ${ratio}`;
  return mode === 'cut' ? `Output: ${ratio} (${seconds}s)` : `Output: ${ratio} (${seconds}s speed-up)`;
};

/**
 * Every output a source of this length can fill, in either mode.
 *
 * Each ratio composites exactly once. In cut mode the longest output carries
 * the composite and the shorter ones trim from it with a stream copy; in speed
 * mode the full length carries it and the shorter ones retime from it. Either
 * way a run costs one composite per ratio however many lengths are ticked.
 */
export function deriveOutputs(
  inputRatio: InputRatio,
  fgDuration: number | undefined,
  mode: LengthMode,
): OutputConfig[] {
  const tiers = activeTiers(mode, fgDuration);
  const withFull = needsFullLength(mode, fgDuration, tiers);
  const outputs: OutputConfig[] = [];

  for (const ratio of RATIOS) {
    const full: OutputConfig | undefined = withFull
      ? { id: ratio, ratio, label: label(ratio, mode), showPreview: true }
      : undefined;

    // In cut mode without a full-length output, the longest tier is the
    // composite and the rest trim from it.
    const longestTier = tiers.length > 0 ? tiers[tiers.length - 1] : undefined;
    const parentId = full ? full.id : `${ratio}-${longestTier}s`;

    if (full) outputs.push(full);

    for (const seconds of tiers) {
      const id = `${ratio}-${seconds}s`;
      const isParent = id === parentId;
      outputs.push({
        id,
        ratio,
        duration: seconds,
        label: label(ratio, mode, seconds),
        ...(isParent
          ? { showPreview: true }
          : mode === 'cut'
            ? { trimFrom: parentId, showPreview: false }
            : { speedFrom: parentId, showPreview: false }),
      });
    }
  }

  return outputs;
}

/**
 * Narrows a catalog to what the user ticked.
 *
 * It makes no decisions: which output carries the composite was fixed when the
 * catalog was derived. A selected child still needs its parent — the catalog
 * offers the parent, it cannot force it into the selection. `renderPlan` is
 * what pulls the parent in.
 */
export const planSelectedOutputs = (
  available: OutputConfig[],
  selectedIds: ReadonlySet<string>,
): OutputConfig[] => available.filter((output) => selectedIds.has(output.id));
```

- [ ] **Step 4: Update the existing derivation test to pass a mode**

`test/output-derivation.test.ts` calls `deriveOutputs(input, duration)`. Add `'speed'` as the third argument at every call site in that file — it was written against the speed model. Then add at the top:

```ts
const deriveSpeed = (input: InputRatio, d?: number) => deriveOutputs(input, d, 'speed');
```

and use it, so the file stays readable.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all green, including the new mode tests. Fix any call site the type-checker flags — `batchOutputs.ts` calls `deriveOutputs` and now needs a mode threaded through.

- [ ] **Step 6: Commit**

```bash
git add src/core/outputDerivation.ts test/output-derivation.test.ts test/output-derivation-modes.test.ts src/core/batchOutputs.ts
git commit -m "$(cat <<'EOF'
feat(core): keep cutting and speeding up as two modes, not two eras

The working tree had replaced cuts with speed-ups outright. Both are
worth having: a cut is cheap and exact, a speed-up keeps the payoff that
usually sits at the end of an ad. Settings picks one.

The margins differ because the failure modes differ. Cut mode needs only
d > T. Speed mode needs half a second more, because buildOutputFilename
rounds and a 30.2s source would otherwise name its full-length output
_30s alongside the real 30s one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: The render plan — jobs in dependency order

**Files:**
- Create: `src/core/renderPlan.ts`
- Create: `test/render-plan.test.ts`

**Interfaces:**
- Consumes: `OutputConfig`, `LengthMode` (Task 6); `ResizeBatchSource` (`src/core/librarySources.ts`)
- Produces:
  - `interface PlannedJob { id: string; sourceId: string; outputId: string; ratio: AspectRatio; duration?: number; filename: string; dependsOn?: string; kind: 'composite' | 'trim' | 'speed' }`
  - `planBatch(sources: ResizeBatchSource[], selectedIds: ReadonlySet<string>, mode: LengthMode): PlannedJob[]`

- [ ] **Step 1: Write the failing test**

Create `test/render-plan.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { planBatch } from '../src/core/renderPlan.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const source = (id: string, duration: number, version = 'v60'): ResizeBatchSource => ({
  localId: id,
  filename: `${id}.mp4`,
  duration,
  inputRatio: '9:16',
  gameName: 'BubbleTea',
  version,
  suffix: 'TTO',
});

test('ticking only a child pulls its parent into the plan', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-15s']), 'speed');
  const kinds = jobs.map((job) => job.kind);
  assert.deepEqual(kinds, ['composite', 'speed']);
  assert.equal(jobs[1].dependsOn, jobs[0].id);
});

test('a parent appears once however many children were ticked', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-15s', '9:16-30s']), 'speed');
  assert.equal(jobs.filter((job) => job.kind === 'composite').length, 1);
  assert.equal(jobs.filter((job) => job.kind === 'speed').length, 2);
});

test('a parent always comes before the children that need it', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16', '9:16-15s', '9:16-30s']), 'speed');
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.dependsOn) assert.ok(seen.has(job.dependsOn), `${job.id} runs before its parent`);
    seen.add(job.id);
  }
});

test('a tier the source cannot fill is dropped for that source alone', () => {
  const jobs = planBatch([source('short', 20), source('long', 200)], new Set(['9:16-30s']), 'speed');
  assert.deepEqual(jobs.filter((j) => j.sourceId === 'short').map((j) => j.kind), ['composite']);
  assert.deepEqual(jobs.filter((j) => j.sourceId === 'long').map((j) => j.kind), ['composite', 'speed']);
});

test('cut children trim and speed children retime', () => {
  const cut = planBatch([source('a', 200)], new Set(['9:16-30s']), 'cut');
  assert.equal(cut.find((j) => j.duration === 30)?.kind, 'trim');

  const speed = planBatch([source('a', 200)], new Set(['9:16-30s']), 'speed');
  assert.equal(speed.find((j) => j.duration === 30)?.kind, 'speed');
});

test('every job carries the filename it will write', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-30s']), 'speed');
  const names = jobs.map((job) => job.filename);
  assert.ok(names.includes('BubbleTea_v60_9x16_30s_TTO.mp4'));
  assert.ok(names.includes('BubbleTea_v60_9x16_TTO.mp4'));
});

test('two sources never collide, their versions differ', () => {
  const jobs = planBatch(
    [source('a', 200, 'v60'), source('b', 200, 'v61')],
    new Set(['9:16']),
    'speed',
  );
  const names = jobs.map((job) => job.filename);
  assert.equal(new Set(names).size, names.length);
});

test('nothing ticked plans nothing', () => {
  assert.deepEqual(planBatch([source('a', 200)], new Set(), 'speed'), []);
});

test('cut mode orders parents first even when the catalog does not', () => {
  // The trap this test exists for: at d = 120.5 the full-length output is
  // dropped, so the composite is the 120s tier -- which `deriveOutputs` lists
  // LAST, after the children that trim from it. A plan that inherited the
  // catalog's order would schedule every child before the file it reads.
  const jobs = planBatch(
    [source('a', 120.5)],
    new Set(['9:16-6s', '9:16-120s']),
    'cut',
  );
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.dependsOn) assert.ok(seen.has(job.dependsOn), `${job.id} is scheduled before its parent`);
    seen.add(job.id);
  }
  assert.equal(jobs[0].kind, 'composite');
  assert.equal(jobs[0].duration, 120, 'the longest tier carries the composite');
});

test('every dependsOn names a job that is actually in the plan', () => {
  // A dangling parent would mean rendering a child from a file this run never
  // writes -- silently, from whatever an older run left in the folder.
  for (const [mode, duration] of [['cut', 120.5], ['cut', 200], ['speed', 200]] as const) {
    const jobs = planBatch([source('a', duration)], new Set([
      '9:16', '9:16-6s', '9:16-15s', '9:16-30s', '9:16-120s',
    ]), mode);
    const ids = new Set(jobs.map((job) => job.id));
    for (const job of jobs) {
      if (job.dependsOn) assert.ok(ids.has(job.dependsOn), `${job.id} depends on a job that is not planned`);
    }
  }
});

test('job ids are unique across a whole batch', () => {
  const sources = [source('a', 200), source('b', 200, 'v61'), source('c', 200, 'v62')];
  const jobs = planBatch(sources, new Set(['9:16', '9:16-15s', '16:9']), 'speed');
  const ids = jobs.map((job) => job.id);
  assert.equal(new Set(ids).size, ids.length);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/render-plan.test.ts`
Expected: FAIL — cannot find module `../src/core/renderPlan.ts`

- [ ] **Step 3: Implement**

Create `src/core/renderPlan.ts`:

```ts
import { AspectRatio } from './contract';
import { ResizeBatchSource } from './librarySources';
import { LengthMode, OutputConfig, deriveOutputs } from './outputDerivation';
import { buildOutputFilename } from './naming';

export interface PlannedJob {
  id: string;
  sourceId: string;
  outputId: string;
  ratio: AspectRatio;
  duration?: number;
  filename: string;
  /** Job id this one reads from. Absent on a composite. */
  dependsOn?: string;
  kind: 'composite' | 'trim' | 'speed';
}

const jobId = (sourceId: string, outputId: string) => `${sourceId}::${outputId}`;

const parentOf = (output: OutputConfig): string | undefined => output.trimFrom ?? output.speedFrom;

const kindOf = (output: OutputConfig): PlannedJob['kind'] => {
  if (output.trimFrom) return 'trim';
  if (output.speedFrom) return 'speed';
  return 'composite';
};

/**
 * Turns a tick-list into an ordered job list.
 *
 * Two things the selection cannot express on its own. A child needs its
 * parent, and the user only ticked the child — the parent is pulled in here,
 * not forced into the catalog. And a tier belongs to a source: in a batch of
 * mixed lengths, a 20s clip simply has no 30s output, so the tick quietly does
 * not apply to it.
 *
 * Parents are emitted before their children so a queue can walk the list in
 * order and never start a job whose input does not exist yet.
 */
export const planBatch = (
  sources: ResizeBatchSource[],
  selectedIds: ReadonlySet<string>,
  mode: LengthMode,
): PlannedJob[] => {
  const jobs: PlannedJob[] = [];

  for (const source of sources) {
    const catalog = deriveOutputs(source.inputRatio ?? '9:16', source.duration, mode);
    const byId = new Map(catalog.map((output) => [output.id, output]));

    const wanted = catalog.filter((output) => selectedIds.has(output.id));
    if (wanted.length === 0) continue;

    // A ticked child drags its parent in. Walking up the chain rather than
    // assuming one level keeps this correct if a mode ever nests deeper.
    const required = new Set<string>();
    const pullIn = (id: string) => {
      if (required.has(id)) return;
      const output = byId.get(id);
      if (!output) return;
      const parent = parentOf(output);
      if (parent) pullIn(parent);
      required.add(id);
    };
    for (const output of wanted) pullIn(output.id);

    // `required` is in dependency order, because `pullIn` adds a parent before
    // the child that asked for it. Do NOT iterate `catalog` here instead: its
    // order is for display, and in cut mode without a full-length output the
    // composite is the longest tier and therefore comes last.
    for (const id of required) {
      const output = byId.get(id)!;
      const parent = parentOf(output);
      jobs.push({
        id: jobId(source.localId, output.id),
        sourceId: source.localId,
        outputId: output.id,
        ratio: output.ratio,
        duration: output.duration,
        filename: buildOutputFilename(
          { gameName: source.gameName, version: source.version, suffix: source.suffix },
          output.ratio,
          output.duration,
        ),
        ...(parent ? { dependsOn: jobId(source.localId, parent) } : {}),
        kind: kindOf(output),
      });
    }
  }

  return jobs;
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test test/render-plan.test.ts`
Expected: 9 passing

- [ ] **Step 5: Commit**

```bash
git add src/core/renderPlan.ts test/render-plan.test.ts
git commit -m "$(cat <<'EOF'
feat(core): turn a tick-list into jobs a queue can walk in order

Two things a selection cannot say. A ticked 15s output needs the full
render it comes from, and the user never ticked that; the catalog can
only offer it, so the plan pulls it in. And a tier belongs to a source,
not to the batch: among mixed lengths a 20s clip has no 30s output, and
the tick quietly does not apply to it.

Parents are emitted ahead of their children, so the queue can walk the
list and never start a job whose input is not written yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: The queue — N at a time, dependencies respected

**Files:**
- Create: `src/core/renderQueue.ts`
- Create: `test/render-queue.test.ts`

**Interfaces:**
- Consumes: `PlannedJob` (Task 7)
- Produces:
  - `type JobState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'`
  - `runQueue(jobs: PlannedJob[], opts: { concurrency: number; run: (job: PlannedJob) => Promise<void>; onChange?: (id: string, state: JobState, error?: string) => void }): Promise<Map<string, JobState>>`

- [ ] **Step 1: Write the failing test**

Create `test/render-queue.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { runQueue } from '../src/core/renderQueue.ts';
import { PlannedJob } from '../src/core/renderPlan.ts';

const job = (id: string, dependsOn?: string): PlannedJob => ({
  id, sourceId: 'a', outputId: id, ratio: '9:16',
  filename: `${id}.mp4`, kind: dependsOn ? 'speed' : 'composite',
  ...(dependsOn ? { dependsOn } : {}),
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('never runs more than the concurrency at once', async () => {
  let running = 0;
  let peak = 0;
  await runQueue([job('1'), job('2'), job('3'), job('4')], {
    concurrency: 2,
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    },
  });
  assert.equal(peak, 2);
});

test('a child does not start before its parent finishes', async () => {
  const order: string[] = [];
  const parent = deferred();
  const promise = runQueue([job('p'), job('c', 'p')], {
    concurrency: 4,
    run: async (j) => {
      order.push(j.id);
      if (j.id === 'p') await parent.promise;
    },
  });

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['p'], 'the child must not have started yet');

  parent.resolve();
  await promise;
  assert.deepEqual(order, ['p', 'c']);
});

test('a failed parent skips its children instead of rendering from nothing', async () => {
  const states = await runQueue([job('p'), job('c', 'p')], {
    concurrency: 2,
    run: async (j) => { if (j.id === 'p') throw new Error('ffmpeg exited with code 1'); },
  });
  assert.equal(states.get('p'), 'failed');
  assert.equal(states.get('c'), 'skipped');
});

test('one failure does not stop unrelated jobs', async () => {
  const states = await runQueue([job('bad'), job('good')], {
    concurrency: 1,
    run: async (j) => { if (j.id === 'bad') throw new Error('boom'); },
  });
  assert.equal(states.get('bad'), 'failed');
  assert.equal(states.get('good'), 'done');
});

test('state changes are reported as they happen', async () => {
  const seen: Array<[string, string]> = [];
  await runQueue([job('1')], {
    concurrency: 1,
    run: async () => {},
    onChange: (id, state) => seen.push([id, state]),
  });
  assert.deepEqual(seen, [['1', 'running'], ['1', 'done']]);
});

test('the error message survives to the caller', async () => {
  const seen: string[] = [];
  await runQueue([job('1')], {
    concurrency: 1,
    run: async () => { throw new Error('ffmpeg exited with code 1\nUnknown encoder'); },
    onChange: (_id, state, error) => { if (state === 'failed' && error) seen.push(error); },
  });
  assert.match(seen[0], /Unknown encoder/);
});

test('an empty plan resolves rather than hanging', async () => {
  assert.equal((await runQueue([], { concurrency: 2, run: async () => {} })).size, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/render-queue.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

Create `src/core/renderQueue.ts`:

```ts
import { PlannedJob } from './renderPlan';

export type JobState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface QueueOptions {
  concurrency: number;
  run: (job: PlannedJob) => Promise<void>;
  onChange?: (id: string, state: JobState, error?: string) => void;
}

/**
 * Runs a plan N jobs at a time.
 *
 * Nothing here is persisted. The web version wrote its queue to disk because
 * a server outlives a request; a desktop app does not outlive its window, and
 * that file is what once poisoned a promise chain and stalled fifty jobs
 * behind free slots.
 *
 * A failed parent skips its children rather than failing them: there is no
 * input to render from, and marking that as a failure would send someone
 * looking for an ffmpeg error that never happened.
 */
export const runQueue = async (
  jobs: PlannedJob[],
  { concurrency, run, onChange }: QueueOptions,
): Promise<Map<string, JobState>> => {
  const states = new Map<string, JobState>(jobs.map((job) => [job.id, 'waiting' as JobState]));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const set = (id: string, state: JobState, error?: string) => {
    states.set(id, state);
    onChange?.(id, state, error);
  };

  const ready = (job: PlannedJob): boolean => {
    if (states.get(job.id) !== 'waiting') return false;
    if (!job.dependsOn) return true;
    return states.get(job.dependsOn) === 'done';
  };

  const doomed = (job: PlannedJob): boolean => {
    if (!job.dependsOn) return false;
    const parent = states.get(job.dependsOn);
    return parent === 'failed' || parent === 'skipped';
  };

  const slots = Math.max(1, Math.floor(concurrency));
  const inFlight = new Set<Promise<void>>();

  const start = (job: PlannedJob) => {
    set(job.id, 'running');
    const task = run(job)
      .then(() => set(job.id, 'done'))
      .catch((error: unknown) => {
        set(job.id, 'failed', error instanceof Error ? error.message : String(error));
      })
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);
  };

  for (;;) {
    // Resolve doomed jobs first so they free their place in the same pass
    // that killed their parent, rather than one pass later.
    let changed = false;
    for (const job of jobs) {
      if (states.get(job.id) === 'waiting' && doomed(job)) {
        set(job.id, 'skipped');
        changed = true;
      }
    }

    while (inFlight.size < slots) {
      const next = jobs.find(ready);
      if (!next) break;
      start(next);
      changed = true;
    }

    if (inFlight.size === 0) {
      if (!changed) break;
      continue;
    }

    await Promise.race(inFlight);
  }

  // Anything still waiting had a parent that never finished.
  for (const [id, state] of states) {
    if (state === 'waiting') set(id, byId.get(id)?.dependsOn ? 'skipped' : 'failed', 'never started');
  }

  return states;
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test test/render-queue.test.ts`
Expected: 7 passing

- [ ] **Step 5: Commit**

```bash
git add src/core/renderQueue.ts test/render-queue.test.ts
git commit -m "$(cat <<'EOF'
feat(core): schedule renders without a file on disk to lose

The web version persisted its queue because a server outlives a request.
A desktop app does not outlive its window, and that file is exactly what
once poisoned a promise chain and left fifty jobs waiting behind free
slots with nothing scheduling them.

A failed parent skips its children rather than failing them. There is no
input to render from, and calling that a failure sends someone looking
for an ffmpeg error that never happened.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Name collisions against the real folder

`namingHistory.ts` guessed at this because the server could not see the user's disk. Now the folder is the record.

**Files:**
- Create: `src/core/outputCollision.ts`
- Create: `test/output-collision.test.ts`
- Delete: `src/naming/namingHistory.ts`, `test/naming-history.test.ts`

**Interfaces:**
- Consumes: `PlannedJob` (Task 7), `listFiles` (Task 4)
- Produces:
  - `findCollisions(jobs: PlannedJob[], existing: string[]): string[]` — filenames that already exist, in plan order, deduped
  - `dropColliding(jobs: PlannedJob[], collisions: string[]): PlannedJob[]`

- [ ] **Step 1: Write the failing test**

Create `test/output-collision.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCollisions, dropColliding } from '../src/core/outputCollision.ts';
import { PlannedJob } from '../src/core/renderPlan.ts';

const job = (id: string, filename: string, dependsOn?: string): PlannedJob => ({
  id, sourceId: 'a', outputId: id, ratio: '9:16', filename,
  kind: dependsOn ? 'speed' : 'composite',
  ...(dependsOn ? { dependsOn } : {}),
});

test('a name already in the folder is reported', () => {
  const jobs = [job('1', 'Game_v60_9x16.mp4'), job('2', 'Game_v60_16x9.mp4')];
  assert.deepEqual(findCollisions(jobs, ['Game_v60_9x16.mp4', 'unrelated.mp4']), ['Game_v60_9x16.mp4']);
});

test('comparison ignores case, because Windows does', () => {
  const jobs = [job('1', 'Game_v60_9x16.mp4')];
  assert.deepEqual(findCollisions(jobs, ['GAME_V60_9X16.MP4']), ['Game_v60_9x16.mp4']);
});

test('an empty folder collides with nothing', () => {
  assert.deepEqual(findCollisions([job('1', 'a.mp4')], []), []);
});

test('a name wanted by two jobs is reported once', () => {
  const jobs = [job('1', 'same.mp4'), job('2', 'same.mp4')];
  assert.deepEqual(findCollisions(jobs, ['same.mp4']), ['same.mp4']);
});

test('skipping a colliding parent skips the children that needed it', () => {
  const jobs = [job('p', 'parent.mp4'), job('c', 'child.mp4', 'p')];
  assert.deepEqual(dropColliding(jobs, ['parent.mp4']).map((j) => j.id), []);
});

test('skipping a colliding child leaves its parent alone', () => {
  const jobs = [job('p', 'parent.mp4'), job('c', 'child.mp4', 'p')];
  assert.deepEqual(dropColliding(jobs, ['child.mp4']).map((j) => j.id), ['p']);
});

test('no collisions leaves the plan untouched', () => {
  const jobs = [job('p', 'parent.mp4'), job('c', 'child.mp4', 'p')];
  assert.deepEqual(dropColliding(jobs, []), jobs);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/output-collision.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

Create `src/core/outputCollision.ts`:

```ts
import { PlannedJob } from './renderPlan';

/**
 * Which planned filenames already sit in the output folder.
 *
 * The web version kept a history of names it had rendered, because the server
 * could not see the user's disk. The folder itself is a better record: it
 * knows about files put there by hand, by an older version, or by a colleague,
 * and it forgets nothing when a browser profile is cleared.
 */
export const findCollisions = (jobs: PlannedJob[], existing: string[]): string[] => {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    const key = job.filename.toLowerCase();
    if (!taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    found.push(job.filename);
  }
  return found;
};

/**
 * Removes the colliding jobs, and anything that depended on them.
 *
 * Keeping a child whose parent was skipped would render it from a file this
 * run never wrote — either a stale one from an older run, or nothing at all.
 */
export const dropColliding = (jobs: PlannedJob[], collisions: string[]): PlannedJob[] => {
  const blocked = new Set(collisions.map((name) => name.toLowerCase()));
  const dropped = new Set<string>();

  for (const job of jobs) {
    if (blocked.has(job.filename.toLowerCase())) dropped.add(job.id);
    else if (job.dependsOn && dropped.has(job.dependsOn)) dropped.add(job.id);
  }

  return jobs.filter((job) => !dropped.has(job.id));
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test test/output-collision.test.ts`
Expected: 7 passing

- [ ] **Step 5: Delete the module this replaces**

```bash
git rm src/naming/namingHistory.ts test/naming-history.test.ts
npx tsc --noEmit
```

Remove every import of `namingHistory` the type-checker reports — they are all in `src/App.tsx`, which Task 12 rewrites anyway. Deleting the call sites now is fine.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(core): ask the folder what is already there

namingHistory existed because a server cannot see the user's disk, so it
kept its own list of names it had rendered. The folder is the better
record: it knows about files put there by hand, by an older build or by a
colleague, and it does not forget when a browser profile is cleared.

Skipping a colliding parent skips its children too. Rendering a child
from a file this run did not write means retiming whatever an older run
left behind.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Picked paths become batch sources

**Files:**
- Create: `src/core/batchSources.ts`
- Create: `test/batch-sources.test.ts`
- Delete: `src/render/batchUpload.ts`, `test/batch-upload.test.ts`

**Interfaces:**
- Consumes: `NamingConfig` (`src/core/naming/namingConfig.ts`), `ResizeBatchSource`
- Produces:
  - `interface ProbedSource { path: string; duration: number; width: number; height: number }`
  - `basename(path: string): string`
  - `inputRatioFor(width: number, height: number): InputRatio`
  - `buildBatchSources(probed: ProbedSource[], config: NamingConfig): ResizeBatchSource[]`

- [ ] **Step 1: Write the failing test**

Create `test/batch-sources.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, inputRatioFor, buildBatchSources } from '../src/core/batchSources.ts';
import { NamingConfig } from '../src/core/naming/namingConfig.ts';

const probed = (path: string, duration = 30, width = 1080, height = 1920) =>
  ({ path, duration, width, height });

const locked = (over: Partial<NamingConfig> = {}): NamingConfig => ({
  locked: true, gameName: 'BubbleTea', version: 'v60', suffix: 'TTO', ...over,
});

test('a Windows path yields its filename', () => {
  assert.equal(basename('D:\\Creative\\hooks\\hook_a.mp4'), 'hook_a.mp4');
});

test('a forward-slash path works too, Tauri can return either', () => {
  assert.equal(basename('D:/Creative/hook_a.mp4'), 'hook_a.mp4');
});

test('portrait and landscape are told apart, square counts as portrait', () => {
  assert.equal(inputRatioFor(1080, 1920), '9:16');
  assert.equal(inputRatioFor(1920, 1080), '16:9');
  assert.equal(inputRatioFor(1080, 1080), '9:16');
});

test('a locked config renames every source and counts the version up', () => {
  const sources = buildBatchSources(
    [probed('D:\\a.mp4'), probed('D:\\b.mp4'), probed('D:\\c.mp4')],
    locked(),
  );
  assert.deepEqual(sources.map((s) => s.version), ['v60', 'v61', 'v62']);
  assert.equal(sources.every((s) => s.gameName === 'BubbleTea'), true);
  assert.equal(sources.every((s) => s.suffix === 'TTO'), true);
});

test('zero padding survives the count', () => {
  const sources = buildBatchSources([probed('D:\\a.mp4'), probed('D:\\b.mp4')], locked({ version: 'v08' }));
  assert.deepEqual(sources.map((s) => s.version), ['v08', 'v09']);
});

test('a version with no trailing number is left alone for validation to refuse', () => {
  const sources = buildBatchSources([probed('D:\\a.mp4'), probed('D:\\b.mp4')], locked({ version: 'final' }));
  assert.deepEqual(sources.map((s) => s.version), ['final', 'final']);
});

test('an unlocked config falls back to reading the filename', () => {
  const [source] = buildBatchSources([probed('D:\\HeroWars_v3_UGC.mp4')], {
    locked: false, gameName: '', version: '', suffix: '',
  });
  assert.equal(source.gameName, 'HeroWars');
  assert.equal(source.version, 'v3');
});

test('each source keeps its own path, ratio and duration', () => {
  const sources = buildBatchSources(
    [probed('D:\\p.mp4', 30, 1080, 1920), probed('D:\\l.mp4', 45, 1920, 1080)],
    locked(),
  );
  assert.deepEqual(sources.map((s) => s.inputRatio), ['9:16', '16:9']);
  assert.deepEqual(sources.map((s) => s.duration), [30, 45]);
  assert.deepEqual(sources.map((s) => s.path), ['D:\\p.mp4', 'D:\\l.mp4']);
});

test('local ids are unique even when two folders hold the same filename', () => {
  const sources = buildBatchSources(
    [probed('D:\\one\\clip.mp4'), probed('D:\\two\\clip.mp4')],
    locked(),
  );
  assert.notEqual(sources[0].localId, sources[1].localId);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/batch-sources.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Add `path` to the source type**

In `src/core/librarySources.ts`, replace the interface:

```ts
import { InputRatio } from './contract';

export interface ResizeBatchSource {
  localId: string;
  /** Absolute path on disk. The file is read where it sits; nothing is copied. */
  path: string;
  filename: string;
  duration: number;
  inputRatio?: InputRatio;
  gameName: string;
  version: string;
  suffix: string;
}
```

`libraryId`, `uploadId`, `pendingOutputIds` and `completedPrimaryJobIds` all described a server that no longer exists.

- [ ] **Step 4: Implement**

Create `src/core/batchSources.ts`:

```ts
import { InputRatio } from './contract';
import { ResizeBatchSource } from './librarySources';
import { NamingConfig } from './naming/namingConfig';
import { sequenceVersions } from './naming/versionSequence';
import { parseVideoNamingMeta } from './naming';

export interface ProbedSource {
  path: string;
  duration: number;
  width: number;
  height: number;
}

/** Last segment of a path. Tauri returns either separator depending on the dialog. */
export const basename = (path: string): string => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

/** Square counts as portrait: a 1:1 source composes like a tall one, not a wide one. */
export const inputRatioFor = (width: number, height: number): InputRatio =>
  (width > height ? '16:9' : '9:16');

/**
 * Picked files become the batch.
 *
 * The version counts up per source, because one shared version renders every
 * video to the same filename. A version with no trailing number is left
 * exactly as configured so `validateBatchNaming` can refuse the run and say
 * why — silently inventing `final-2` would hide the mistake under a name
 * nobody chose.
 */
export const buildBatchSources = (
  probed: ProbedSource[],
  config: NamingConfig,
): ResizeBatchSource[] => {
  const versions = config.locked ? sequenceVersions(config.version, probed.length) : null;

  return probed.map((item, index) => {
    const filename = basename(item.path);
    const detected = config.locked ? {} : parseVideoNamingMeta(filename);
    return {
      // The path, not the filename: two folders may hold the same name.
      localId: `${index}:${item.path}`,
      path: item.path,
      filename,
      duration: item.duration,
      inputRatio: inputRatioFor(item.width, item.height),
      gameName: config.locked ? config.gameName : (detected.gameName ?? ''),
      version: config.locked ? (versions?.[index] ?? config.version) : (detected.version ?? ''),
      suffix: config.locked ? config.suffix : (detected.suffix ?? ''),
    };
  });
};
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx tsx --test test/batch-sources.test.ts`
Expected: 9 passing

- [ ] **Step 6: Delete the upload version and fix fallout**

```bash
git rm src/render/batchUpload.ts test/batch-upload.test.ts
npx tsc --noEmit
```

`src/core/batchOutputs.ts` and `src/core/batchNaming.ts` reference the removed fields. Replace `source.libraryId!` with `source.localId` in both. Run `npm test` and fix the test files that construct a `ResizeBatchSource` — they need `path` and no longer take `libraryId`/`uploadId`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(core): build the batch from paths instead of uploads

A source is now a file where the user left it. libraryId, uploadId and
the pending-job bookkeeping all described a server round trip that no
longer happens.

localId keys on the path rather than the filename, because two folders
routinely hold a clip of the same name and the whole batch is keyed by it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: The original, copied and made playable

**Files:**
- Create: `src/core/originalCopy.ts`
- Create: `test/original-copy.test.ts`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`
- Reference: `src/core/sourceNormalize.ts`

**Interfaces:**
- Consumes: `ResizeBatchSource`, `buildNormalizeCommand` (`src/core/sourceNormalize.ts`), `buildOutputFilename`
- Produces:
  - `originalFilename(source: ResizeBatchSource): string`
  - `planOriginal(source, codec: string | null, outputFolder: string): { action: 'copy' | 'convert'; from: string; to: string }`
  - Rust: `invoke('copy_file', { from, to })`, `invoke('probe_codec', { path }) -> string | null`

- [ ] **Step 1: Write the failing test**

Create `test/original-copy.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { originalFilename, planOriginal } from '../src/core/originalCopy.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const source = (over: Partial<ResizeBatchSource> = {}): ResizeBatchSource => ({
  localId: '0:D:\\in\\hook.mov',
  path: 'D:\\in\\hook.mov',
  filename: 'hook.mov',
  duration: 32.4,
  inputRatio: '9:16',
  gameName: 'BubbleTea',
  version: 'v60',
  suffix: 'TTO',
  ...over,
});

test('the copy is named from the config but timed from the file', () => {
  // 32.4s rounds to 32s. The config never carries a duration -- that was the
  // rule from the web version and it still holds.
  assert.equal(originalFilename(source()), 'BubbleTea_v60_9x16_32s_TTO.mp4');
});

test('a landscape original is labelled 16:9', () => {
  assert.equal(originalFilename(source({ inputRatio: '16:9' })), 'BubbleTea_v60_16x9_32s_TTO.mp4');
});

test('an h264 source is copied, not re-encoded', () => {
  const plan = planOriginal(source(), 'h264', 'D:\\out');
  assert.equal(plan.action, 'copy');
  assert.equal(plan.to, 'D:\\out\\BubbleTea_v60_9x16_32s_TTO.mp4');
});

test('an HEVC source is converted, because nobody else can open it', () => {
  // This is the seven files on the shared drive that would not play.
  assert.equal(planOriginal(source(), 'hevc', 'D:\\out').action, 'convert');
  assert.equal(planOriginal(source(), 'h265', 'D:\\out').action, 'convert');
});

test('an unreadable codec is converted rather than assumed fine', () => {
  assert.equal(planOriginal(source(), null, 'D:\\out').action, 'convert');
});

test('codec comparison ignores case', () => {
  assert.equal(planOriginal(source(), 'H264', 'D:\\out').action, 'copy');
});

test('the destination always ends in .mp4 whatever the source was', () => {
  const plan = planOriginal(source({ filename: 'hook.webm', path: 'D:\\in\\hook.webm' }), 'vp9', 'D:\\out');
  assert.match(plan.to, /\.mp4$/);
  assert.equal(plan.from, 'D:\\in\\hook.webm');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/original-copy.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

Create `src/core/originalCopy.ts`:

```ts
import { ResizeBatchSource } from './librarySources';
import { buildOutputFilename } from './naming';

/** Codecs every machine on the team can open without installing anything. */
const PLAYABLE = new Set(['h264', 'avc1', 'avc']);

/**
 * The original's name follows the config, its length follows the file.
 *
 * Deliberately split: a config says what the creative is, it cannot know how
 * long a given take ran. Letting the config supply the duration is how two
 * different takes end up under one name.
 */
export const originalFilename = (source: ResizeBatchSource): string => buildOutputFilename(
  { gameName: source.gameName, version: source.version, suffix: source.suffix },
  source.inputRatio ?? '9:16',
  source.duration,
);

/**
 * Copy when the source is already h264, convert otherwise.
 *
 * An unknown codec converts. Guessing "probably fine" is how seven HEVC files
 * reached a shared drive and would not open on anyone else's machine.
 */
export const planOriginal = (
  source: ResizeBatchSource,
  codec: string | null,
  outputFolder: string,
): { action: 'copy' | 'convert'; from: string; to: string } => ({
  action: codec && PLAYABLE.has(codec.toLowerCase()) ? 'copy' : 'convert',
  from: source.path,
  to: `${outputFolder}\\${originalFilename(source)}`,
});
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test test/original-copy.test.ts`
Expected: 7 passing

- [ ] **Step 5: Add the two Rust commands**

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn copy_file(from: String, to: String) -> Result<(), String> {
    std::fs::copy(&from, &to).map(|_| ()).map_err(|e| format!("{from} -> {to}: {e}"))
}

/// The video codec of a file, read from `ffmpeg -i`.
///
/// ffprobe would be the obvious tool and is not shipped: it is a 78 MB binary
/// whose only remaining job is this one line, and ffmpeg already prints it.
#[tauri::command]
pub async fn probe_codec(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-hide_banner", "-i", &path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    // `-i` with no output file always exits non-zero; the stream listing is
    // still on stderr, which is what we came for.
    let text = String::from_utf8_lossy(&output.stderr);
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("Stream #") {
            if let Some(video) = rest.split("Video: ").nth(1) {
                if let Some(codec) = video.split([' ', ',']).next() {
                    return Ok(Some(codec.to_string()));
                }
            }
        }
    }
    Ok(None)
}
```

Add both to `generate_handler!` in `main.rs`, and add to `src/bridge/tauri.ts`:

```ts
  copyFile(from: string, to: string): Promise<void>;
  probeCodec(path: string): Promise<string | null>;
```

with the matching `invoke` implementations and `notInTauri` fallbacks.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test`

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(core): put a playable original next to the resized outputs

The original's name comes from the config and its length from the file.
A config says what the creative is; it cannot know how long a given take
ran, and letting it supply the duration is how two takes end up under one
name.

An unknown codec converts rather than copies. Assuming "probably fine" is
how seven HEVC files reached the shared drive and opened on nobody's
machine but the one that made them.

probe_codec reads ffmpeg's own stderr instead of shipping ffprobe: 78 MB
of binary whose last remaining job is one line of text.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Settings

**Files:**
- Create: `src/core/settings.ts`
- Create: `test/settings.test.ts`

**Interfaces:**
- Produces:
  - `interface Settings { lengthMode: LengthMode; outputFolder: string | null; concurrency: number; advancedOpen: boolean }`
  - `DEFAULT_SETTINGS: Settings`
  - `readSettings(storage?: Storage): Settings`
  - `writeSettings(next: Settings, storage?: Storage): void`
  - `defaultConcurrency(cpuCount: number): number`

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, readSettings, writeSettings, defaultConcurrency } from '../src/core/settings.ts';

const fakeStorage = (seed: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  } as Storage;
};

test('an empty store yields the defaults', () => {
  assert.deepEqual(readSettings(fakeStorage()), DEFAULT_SETTINGS);
});

test('settings survive a round trip', () => {
  const store = fakeStorage();
  const next = { lengthMode: 'cut' as const, outputFolder: 'D:\\Out', concurrency: 5, advancedOpen: true };
  writeSettings(next, store);
  assert.deepEqual(readSettings(store), next);
});

test('corrupt JSON yields the defaults rather than throwing', () => {
  // A half-written value must not make the app refuse to start.
  assert.deepEqual(readSettings(fakeStorage({ 'resize.settings': '{not json' })), DEFAULT_SETTINGS);
});

test('an unknown length mode falls back to the default', () => {
  const store = fakeStorage({ 'resize.settings': JSON.stringify({ lengthMode: 'nonsense' }) });
  assert.equal(readSettings(store).lengthMode, DEFAULT_SETTINGS.lengthMode);
});

test('a nonsense concurrency is clamped into range', () => {
  const read = (value: unknown) =>
    readSettings(fakeStorage({ 'resize.settings': JSON.stringify({ concurrency: value }) })).concurrency;
  assert.equal(read(0), 1);
  assert.equal(read(-3), 1);
  assert.equal(read(999), 16);
  assert.equal(read('five'), DEFAULT_SETTINGS.concurrency);
});

test('a storage that throws is survivable', () => {
  // Some locked-down Windows profiles make localStorage throw on write.
  const hostile = { ...fakeStorage(), setItem: () => { throw new Error('denied'); } } as Storage;
  assert.doesNotThrow(() => writeSettings(DEFAULT_SETTINGS, hostile));
});

test('concurrency leaves at least one core for the rest of the machine', () => {
  assert.equal(defaultConcurrency(1), 1);
  assert.equal(defaultConcurrency(8), 3);
  assert.equal(defaultConcurrency(16), 7);
  assert.equal(defaultConcurrency(64), 16);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/settings.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

Create `src/core/settings.ts`:

```ts
import { LengthMode } from './outputDerivation';

export interface Settings {
  lengthMode: LengthMode;
  outputFolder: string | null;
  concurrency: number;
  advancedOpen: boolean;
}

const KEY = 'resize.settings';
const MIN_JOBS = 1;
const MAX_JOBS = 16;

/**
 * Half the cores, minus one, so a batch never takes the whole machine.
 *
 * Each job also caps its own ffmpeg threads. The web version taught this the
 * hard way: lowering the job count alone changed nothing, because the thread
 * cap divides the host by the job count and the product stayed put.
 */
export const defaultConcurrency = (cpuCount: number): number =>
  Math.min(MAX_JOBS, Math.max(MIN_JOBS, Math.floor((cpuCount - 1) / 2) || 1));

export const DEFAULT_SETTINGS: Settings = {
  lengthMode: 'speed',
  outputFolder: null,
  concurrency: 3,
  advancedOpen: false,
};

const store = (given?: Storage): Storage | null => {
  if (given) return given;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const clampJobs = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.concurrency;
  return Math.min(MAX_JOBS, Math.max(MIN_JOBS, Math.round(value)));
};

/**
 * Never throws and never returns a half-valid object.
 *
 * A settings file is the one thing read before anything else works, so a
 * stray value in it has to degrade to the default rather than stop the app.
 */
export const readSettings = (storage?: Storage): Settings => {
  const target = store(storage);
  if (!target) return DEFAULT_SETTINGS;

  let raw: unknown;
  try {
    const text = target.getItem(KEY);
    if (!text) return DEFAULT_SETTINGS;
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;

  const value = raw as Partial<Record<keyof Settings, unknown>>;
  return {
    lengthMode: value.lengthMode === 'cut' || value.lengthMode === 'speed'
      ? value.lengthMode
      : DEFAULT_SETTINGS.lengthMode,
    outputFolder: typeof value.outputFolder === 'string' ? value.outputFolder : null,
    concurrency: 'concurrency' in value ? clampJobs(value.concurrency) : DEFAULT_SETTINGS.concurrency,
    advancedOpen: value.advancedOpen === true,
  };
};

export const writeSettings = (next: Settings, storage?: Storage): void => {
  const target = store(storage);
  if (!target) return;
  try {
    target.setItem(KEY, JSON.stringify(next));
  } catch {
    // A locked-down profile can refuse writes. Losing a preference is not
    // worth failing a render over.
  }
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test test/settings.test.ts`
Expected: 7 passing

- [ ] **Step 5: Commit**

```bash
git add src/core/settings.ts test/settings.test.ts
git commit -m "$(cat <<'EOF'
feat(core): read settings without ever throwing

Settings are read before anything else works, so a stray value has to
degrade to a default rather than stop the app starting. A locked-down
Windows profile can also make localStorage throw outright, and losing a
preference is not worth failing a render over.

The default job count halves the cores and takes one off. The web version
taught why the number alone is not the lever: each job's ffmpeg thread
cap divides the host by the job count, so lowering one raises the other
and the product does not move.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: The render runner — plan to files on disk

Wires Tasks 6–12 together behind one call the UI can make.

**Files:**
- Create: `src/render/runBatch.ts`
- Create: `test/run-batch.test.ts`

**Interfaces:**
- Consumes: `planBatch`, `runQueue`, `buildFfmpegCommand`, `buildSpeedUpCommand`, `buildNormalizeCommand`, `planOriginal`, the bridge
- Produces:
  - `runBatch(input: RunBatchInput): Promise<Map<string, JobState>>` where
    `RunBatchInput = { sources, selectedIds, mode, outputFolder, spec, concurrency, onChange? }`
  - `argvFor(job: PlannedJob, source: ResizeBatchSource, outputFolder: string, spec: RenderSpecBase, threads: number): string[]`

- [ ] **Step 1: Write the failing test**

Create `test/run-batch.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { argvFor } from '../src/render/runBatch.ts';
import { planBatch } from '../src/core/renderPlan.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const source = (): ResizeBatchSource => ({
  localId: '0:D:\\in\\a.mp4', path: 'D:\\in\\a.mp4', filename: 'a.mp4',
  duration: 200, inputRatio: '9:16',
  gameName: 'BubbleTea', version: 'v60', suffix: 'TTO',
});

const spec = {
  fgPosition: 'center' as const,
  bgType: 'video' as const,
  backgroundSource: 'self' as const,
  backgroundImageMode: 'clean' as const,
  blurAmount: 24, bitrate: 6000,
  logoX: 0, logoY: 0, logoSize: 100,
  buttonType: 'text' as const, buttonText: '', buttonX: 0, buttonY: 0, buttonSize: 100,
};

const argvs = (mode: 'cut' | 'speed', selected: string[]) => {
  const src = source();
  return planBatch([src], new Set(selected), mode)
    .map((job) => ({ job, args: argvFor(job, src, 'D:\\out', spec, 2) }));
};

test('a composite reads the source where it sits and writes into the chosen folder', () => {
  const [{ args }] = argvs('speed', ['9:16']);
  assert.ok(args.includes('D:\\in\\a.mp4'), 'reads the original path');
  assert.ok(args.includes('D:\\out\\BubbleTea_v60_9x16_TTO.mp4'), 'writes the planned name');
});

test('a speed child reads its parent output, not the source', () => {
  const found = argvs('speed', ['9:16-15s']).find(({ job }) => job.kind === 'speed');
  assert.ok(found);
  assert.ok(found.args.includes('D:\\out\\BubbleTea_v60_9x16_TTO.mp4'), 'input is the parent file');
  assert.equal(found.args.includes('D:\\in\\a.mp4'), false, 'it must not re-composite from the source');
});

test('a cut child stream-copies rather than re-encoding', () => {
  const found = argvs('cut', ['9:16-30s']).find(({ job }) => job.kind === 'trim');
  assert.ok(found);
  assert.deepEqual(
    [found.args.includes('-c'), found.args.includes('copy'), found.args.includes('-t')],
    [true, true, true],
  );
  assert.equal(found.args.includes('libx264'), false);
});

test('every encoding job carries the thread cap', () => {
  for (const { args } of argvs('speed', ['9:16', '9:16-15s'])) {
    const at = args.indexOf('-filter_complex_threads');
    assert.notEqual(at, -1, 'the thread flag is missing');
    assert.equal(args[at + 1], '2');
  }
});

test('a stream-copy trim carries no thread cap, there is nothing to decode', () => {
  const found = argvs('cut', ['9:16-30s']).find(({ job }) => job.kind === 'trim');
  assert.equal(found!.args.includes('-filter_complex_threads'), false);
});

test('self-blur feeds the source in as its own background', () => {
  const [{ args }] = argvs('speed', ['9:16']);
  const inputs = args.filter((arg, i) => args[i - 1] === '-i');
  assert.deepEqual(inputs, ['D:\\in\\a.mp4', 'D:\\in\\a.mp4']);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/run-batch.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Teach the plan the parent's filename**

`argvFor` needs the file its parent wrote, and `PlannedJob` so far carries only
the parent's job id. Do this before writing `argvFor`, or it will not compile.

In `src/core/renderPlan.ts`, add to `PlannedJob`:

```ts
  /** Filename this job reads from. Absent on a composite. */
  parentFilename?: string;
```

and set it wherever `dependsOn` is set:

```ts
      const parentOutput = parent ? byId.get(parent) : undefined;
      // ...
        ...(parent ? {
          dependsOn: jobId(source.localId, parent),
          parentFilename: buildOutputFilename(
            { gameName: source.gameName, version: source.version, suffix: source.suffix },
            parentOutput!.ratio,
            parentOutput!.duration,
          ),
        } : {}),
```

Add to `test/render-plan.test.ts`:

```ts
test('a child knows the filename it reads, not just the job id', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-15s']), 'speed');
  const child = jobs.find((job) => job.kind === 'speed');
  assert.equal(child?.parentFilename, 'BubbleTea_v60_9x16_TTO.mp4');
});
```

Run: `npx tsx --test test/render-plan.test.ts`
Expected: all passing, including the new one.

- [ ] **Step 4: Implement**

Create `src/render/runBatch.ts`:

```ts
import { PlannedJob, planBatch } from '../core/renderPlan';
import { JobState, runQueue } from '../core/renderQueue';
import { ResizeBatchSource } from '../core/librarySources';
import { LengthMode } from '../core/outputDerivation';
import { buildFfmpegCommand, buildSpeedUpCommand } from '../core/buildCommand';
import { RenderSpec } from '../core/contract';
import { getBridge } from '../bridge/tauri';

/**
 * Everything in a RenderSpec except what the plan decides per output, plus the
 * two background paths.
 *
 * Those paths are not part of RenderSpec -- `buildFfmpegCommand` takes them as
 * separate arguments, because on the server they pointed into an upload
 * directory rather than into the spec. Here they are just paths the user
 * picked, so they travel with the rest of the settings.
 */
export type RenderSpecBase = Omit<
  RenderSpec,
  'inputRatio' | 'outputRatio' | 'duration' | 'naming' | 'outputFilename' | 'speedFromJobId'
> & {
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
};

const join = (folder: string, filename: string) => `${folder}\\${filename}`;

/**
 * The ffmpeg argv for one planned job.
 *
 * A composite reads the source; a child reads the file its parent wrote. That
 * is the whole reason a ratio costs one composite no matter how many lengths
 * were ticked — and the reason a child must never fall back to the source if
 * its parent is missing, which is what `dropColliding` and the queue's skip
 * rule are both protecting.
 */
export const argvFor = (
  job: PlannedJob,
  source: ResizeBatchSource,
  outputFolder: string,
  base: RenderSpecBase,
  threads: number,
): string[] => {
  const outputPath = join(outputFolder, job.filename);

  if (job.kind === 'composite') {
    const spec: RenderSpec = {
      ...base,
      inputRatio: source.inputRatio ?? '9:16',
      outputRatio: job.ratio,
      duration: job.duration,
      naming: { gameName: source.gameName, version: source.version, suffix: source.suffix },
      outputFilename: job.filename,
    };
    return buildFfmpegCommand({
      spec,
      foregroundPath: source.path,
      backgroundVideoPath: base.backgroundSource === 'self' ? source.path : base.backgroundVideoPath,
      backgroundImagePath: base.backgroundImagePath,
      outputPath,
      threads,
    });
  }

  // Both children read the parent's finished frame, so neither redoes the
  // blur, the overlay or the logo.
  const parentName = job.parentFilename;
  if (!parentName) throw new Error(`${job.id} is a ${job.kind} with no parent file`);

  if (job.kind === 'trim') {
    return [
      '-y',
      '-i', join(outputFolder, parentName),
      '-t', String(job.duration),
      '-c', 'copy',
      outputPath,
    ];
  }

  return buildSpeedUpCommand({
    inputPath: join(outputFolder, parentName),
    sourceDuration: source.duration,
    targetDuration: job.duration!,
    outputPath,
    threads,
    bitrate: base.bitrate,
  });
};

export interface RunBatchInput {
  sources: ResizeBatchSource[];
  selectedIds: ReadonlySet<string>;
  mode: LengthMode;
  outputFolder: string;
  spec: RenderSpecBase;
  concurrency: number;
  onChange?: (id: string, state: JobState, error?: string) => void;
}

export const runBatch = async (input: RunBatchInput): Promise<Map<string, JobState>> => {
  const jobs = planBatch(input.sources, input.selectedIds, input.mode);
  const byId = new Map(input.sources.map((source) => [source.localId, source]));
  const bridge = getBridge();

  // Each job's ffmpeg gets its share of the host, so N of them together do
  // not oversubscribe it. One core is left for the rest of the machine.
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  const threads = Math.max(1, Math.floor((cores - 1) / input.concurrency));

  return runQueue(jobs, {
    concurrency: input.concurrency,
    onChange: input.onChange,
    run: async (job) => {
      const source = byId.get(job.sourceId);
      if (!source) throw new Error(`No source for ${job.id}`);
      await bridge.runFfmpeg(job.id, argvFor(job, source, input.outputFolder, input.spec, threads));
    },
  });
};
```

- [ ] **Step 5: Run and watch both files pass**

Run: `npx tsx --test test/run-batch.test.ts test/render-plan.test.ts`
Expected: all passing

- [ ] **Step 6: Commit**

```bash
git add src/render/runBatch.ts test/run-batch.test.ts src/core/renderPlan.ts test/render-plan.test.ts
git commit -m "$(cat <<'EOF'
feat(render): build the argv for every job in a batch

A composite reads the source, a child reads the file its parent wrote.
That is the whole reason a ratio costs one composite however many lengths
were ticked, and it is why a child must never fall back to the source
when its parent is missing: it would redo the blur and the overlay and
quietly cost five times what the plan promised.

The thread cap divides the host by the job count, so N jobs together do
not oversubscribe it, and one core is left for everything else.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: The UI — layout A

The spec's bold choice: one column, no modes, no steps.

**Files:**
- Create: `src/ui/App.tsx`, `src/ui/SourceDrop.tsx`, `src/ui/NamingFields.tsx`, `src/ui/BackgroundChoice.tsx`, `src/ui/PreviewBox.tsx`, `src/ui/OutputMatrix.tsx`, `src/ui/JobList.tsx`, `src/ui/SettingsPanel.tsx`
- Modify: `src/main.tsx`
- Reference (then delete in Task 15): `src/App.tsx`

**Interfaces:**
- Consumes: everything from Tasks 4–13
- Produces: a window that renders a batch

- [ ] **Step 1: Lift the preview out of the old App**

`src/App.tsx:111-400` holds `PreviewBox`. Copy it to `src/ui/PreviewBox.tsx` with two changes: it takes `fgSrc: string` and `bgSrc: string` (URLs from `bridge.fileUrl`) instead of `File` objects, and it drops the `logo`/`button` props into one optional `overlay` object.

- [ ] **Step 2: Write the shell**

Create `src/ui/App.tsx`. The order on screen is fixed by the spec:

```tsx
export default function App() {
  const [settings, setSettings] = useState(readSettings);
  const [sources, setSources] = useState<ResizeBatchSource[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewRatio, setPreviewRatio] = useState<AspectRatio>('9:16');
  const [jobs, setJobs] = useState<Map<string, JobState>>(new Map());
  const [running, setRunning] = useState(false);

  const catalog = useMemo(
    () => deriveBatchOutputCatalog(sources, settings.lengthMode),
    [sources, settings.lengthMode],
  );
  const plan = useMemo(
    () => planBatch(sources, selected, settings.lengthMode),
    [sources, selected, settings.lengthMode],
  );

  const toggleOutput = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const patch = (change: Partial<Settings>) => setSettings((prev) => {
    const next = { ...prev, ...change };
    writeSettings(next);
    return next;
  });

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-5">
      <Header onOpenSettings={() => setSettingsOpen(true)} />

      <SourceDrop sources={sources} onPick={handlePick} onClear={() => setSources([])} />

      <div className="grid grid-cols-2 gap-4">
        <PreviewPane
          sources={sources}
          sourceId={previewId}
          onSourceId={setPreviewId}
          ratio={previewRatio}
          onRatio={setPreviewRatio}
          spec={currentSpec}
        />
        <div className="space-y-4">
          <NamingFields
            config={namingConfig}
            onChange={setNamingConfig}
            onLock={() => setSources(buildBatchSources(probedCache, namingConfig))}
          />
          <BackgroundChoice
            source={currentSpec.backgroundSource}
            bannerPath={currentSpec.backgroundImagePath}
            onSelf={() => setSpec({ ...currentSpec, backgroundSource: 'self', bgType: 'video' })}
            onBanner={async () => {
              const path = await getBridge().pickImage();
              if (path) setSpec({ ...currentSpec, backgroundSource: 'upload', bgType: 'image', backgroundImagePath: path });
            }}
          />
        </div>
      </div>

      <OutputMatrix
        catalog={catalog}
        selected={selected}
        onToggle={toggleOutput}
        mode={settings.lengthMode}
      />

      <OutputFolderField
        value={settings.outputFolder}
        onPick={async () => {
          const folder = await getBridge().pickFolder();
          if (folder) patch({ outputFolder: folder });
        }}
      />

      <Advanced
        open={settings.advancedOpen}
        onToggle={() => patch({ advancedOpen: !settings.advancedOpen })}
        spec={currentSpec}
        onChange={setSpec}
      />

      {running
        ? <JobList plan={plan} states={jobs} onCancel={(id) => getBridge().cancelJob(id)} />
        : <RenderButton
            videoCount={sources.length}
            fileCount={plan.length + sources.length}
            onRender={handleRender}
            disabled={sources.length === 0 || selected.size === 0 || !settings.outputFolder}
          />}

      {finishedFolder && (
        <button onClick={() => getBridge().revealFolder(finishedFolder)}>
          Mở thư mục kết quả
        </button>
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={patch}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}
```

`fileCount` adds `sources.length` because every source also contributes one
copied original — the spec counts that as a delivered file, so the button
should too.

- [ ] **Step 3: Pick and probe**

```tsx
const handlePick = async () => {
  const paths = await getBridge().pickVideos();
  if (paths.length === 0) return;

  // fgDuration already reads duration and dimensions from a <video>. The
  // only change is where the URL comes from.
  const probed: ProbedSource[] = [];
  for (const path of paths) {
    const state = await probeFgDuration(getBridge().fileUrl(path));
    probed.push({
      path,
      duration: state.status === 'ready' ? state.duration : Number.NaN,
      width: state.status === 'ready' ? state.width : 1080,
      height: state.status === 'ready' ? state.height : 1920,
    });
  }
  const next = buildBatchSources(probed, namingConfig);
  setSources(next);
  setPreviewId(next[0]?.localId ?? null);
};
```

A source whose duration is `NaN` gets a warning badge in `SourceDrop` and only the full-length output — `deriveOutputs` already refuses tiers for a non-finite duration.

- [ ] **Step 4: Add the two preflight commands Rust still owes**

The spec's error table demands two checks nothing implements yet: the output
folder has to be writable, and every source has to still be there. Both are
facts about the disk, so both are Rust.

Append to `src-tauri/src/commands.rs`:

```rust
/// Can we actually write here? Creating and removing a probe file is the only
/// honest answer on Windows, where a read-only attribute, a network share and
/// a folder owned by another account all fail differently.
#[tauri::command]
pub fn check_writable(folder: String) -> Result<(), String> {
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
```

Register both in `generate_handler!`, and add to `src/bridge/tauri.ts`:

```ts
  checkWritable(folder: string): Promise<void>;
  missingPaths(paths: string[]): Promise<string[]>;
```

- [ ] **Step 5: Render, with every gate the spec asks for**

```tsx
const handleRender = async () => {
  const folder = settings.outputFolder;
  if (!folder) return;
  setBlockingError(null);

  // 1. Hard block: a shared version renders every video to one filename.
  const namingError = validateBatchNaming(sources);
  if (namingError) { setBlockingError(namingError); return; }

  // 2. Hard block: no point starting 120 renders that cannot be written.
  try {
    await getBridge().checkWritable(folder);
  } catch (error) {
    setBlockingError(`Không ghi được vào ${folder}. ${String(error)}`);
    return;
  }

  // 3. Drop sources that vanished while the batch sat on screen.
  const gone = await getBridge().missingPaths(sources.map((s) => s.path));
  let live = sources;
  if (gone.length > 0) {
    live = sources.filter((source) => !gone.includes(source.path));
    setNotice(`Bỏ qua ${gone.length} video không còn trên đĩa: ${gone.map(basename).join(', ')}`);
    if (live.length === 0) return;
  }

  // 4. Soft warn: the folder is the record of what has been rendered.
  let plannedJobs = planBatch(live, selected, settings.lengthMode);
  const collisions = findCollisions(plannedJobs, await getBridge().listFiles(folder));
  if (collisions.length > 0) {
    const choice = await askOverwrite(collisions);   // 'overwrite' | 'skip' | 'cancel'
    if (choice === 'cancel') return;
    if (choice === 'skip') plannedJobs = dropColliding(plannedJobs, collisions);
  }

  setRunning(true);
  const unlisten = await getBridge().onProgress(handleProgressLine);
  try {
    await runBatch({
      sources: live,
      selectedIds: selected,
      mode: settings.lengthMode,
      outputFolder: folder,
      spec: currentSpec,
      concurrency: settings.concurrency,
      plan: plannedJobs,
      onChange: (id, state, error) => {
        setJobs((prev) => new Map(prev).set(id, state));
        if (state === 'failed' && error) setJobErrors((prev) => new Map(prev).set(id, error));
      },
    });
    await copyOriginals(live, folder);
    setFinishedFolder(folder);
  } finally {
    unlisten();
    setRunning(false);
  }
};
```

`runBatch` currently re-plans internally. Give it an optional
`plan?: PlannedJob[]` so this caller can hand over the plan it already filtered
for collisions, and have `runBatch` fall back to `planBatch(...)` when it is
absent. Add to `test/run-batch.test.ts`:

```ts
test('a supplied plan is used as-is rather than re-derived', async () => {
  const ran: string[] = [];
  setBridge({ runFfmpeg: async (jobId) => { ran.push(jobId); } });
  const src = source();
  const full = planBatch([src], new Set(['9:16', '9:16-15s']), 'speed');
  await runBatch({
    sources: [src], selectedIds: new Set(['9:16', '9:16-15s']), mode: 'speed',
    outputFolder: 'D:\\out', spec, concurrency: 1,
    plan: full.filter((job) => job.kind === 'composite'),
  });
  assert.deepEqual(ran, [full[0].id], 'only the job that was handed over ran');
});
```

`copyOriginals` is the loop over `planOriginal` from Task 11:

```tsx
const copyOriginals = async (list: ResizeBatchSource[], folder: string) => {
  const bridge = getBridge();
  for (const source of list) {
    const codec = await bridge.probeCodec(source.path);
    const plan = planOriginal(source, codec, folder);
    if (plan.action === 'copy') {
      await bridge.copyFile(plan.from, plan.to);
    } else {
      await bridge.runFfmpeg(`original:${source.localId}`,
        buildNormalizeCommand({ inputPath: plan.from, outputPath: plan.to, threads: 2 }));
    }
  }
};
```

- [ ] **Step 6: Point `main.tsx` at the new App**

```tsx
import App from './ui/App';
```

- [ ] **Step 7: Run the app and walk it by hand**

Run: `npm run app:dev`

Check each in turn:
- Drop three videos of different lengths. Each shows its own duration.
- The output matrix shows only tiers at least one source can fill.
- The preview plays, and switching source or ratio changes it.
- Switching length mode in Settings changes the matrix columns.
- Render writes files into the chosen folder with the planned names.
- Rendering twice into the same folder raises the overwrite prompt.
- Picking a read-only folder blocks before any job starts.
- Deleting a source file after picking it, then rendering, drops that one and names it.

- [ ] **Step 8: Commit**

```bash
git add src/ui src/main.tsx
git commit -m "$(cat <<'EOF'
feat(ui): one column, no modes, no steps

Everything the run needs is on one screen in the order you do it. The
previous version stacked a preview per ratio -- five boxes, ten video
elements decoding at once -- and that is most of why it felt heavy. One
preview with a source picker and a ratio picker shows the same thing for
a fifth of the work.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Delete the web half

Nothing imports it any more. Make that true in the file tree.

**Files:**
- Delete: `server/`, `src/composer/`, `src/library/`, `src/App.tsx`, `src/app/AppShell.tsx`, `src/render/api.ts`, `src/render/useJobPolling.ts`, `src/composer/*`, `Dockerfile`, `docker/`, `docker-compose.yml`, `nginx-*.conf*`, `prometheus.yml`, `grafana/`, `install-prometheus.sh`, `deploy-*.ps1`, `deploy-*.md`, `vm-startup.sh`, `upload-to-ubuntu-vm.ps1`, `diagnostic.sh`, `test-*.ps1`, `*.tar.gz`, `MONITORING.md`, `FIX_PROMETHEUS_ACCESS.md`
- Delete: every test under `test/` that imports from `server/`
- Modify: `package.json`, `README.md`, `HANDOFF.md`

**Interfaces:**
- Consumes: nothing
- Produces: a repo with no server in it

- [ ] **Step 1: Find what still points at the server**

```bash
grep -rln "from '.*server/" src test shared 2>/dev/null
grep -rln "localhost:3001\|/api/" src 2>/dev/null
```

Every hit must be gone before deleting, or `npm test` breaks in a way that hides real failures.

- [ ] **Step 2: Delete**

```bash
git rm -r server src/composer src/library src/app docker grafana
git rm src/App.tsx src/render/api.ts src/render/useJobPolling.ts
git rm Dockerfile docker-compose.yml prometheus.yml install-prometheus.sh
git rm nginx-*.conf nginx-*.conf.example vm-startup.sh diagnostic.sh
git rm deploy-gcloud.ps1 deploy-docker-ubuntu.md deploy-guide.md upload-to-ubuntu-vm.ps1
git rm test-*.ps1 *.tar.gz MONITORING.md FIX_PROMETHEUS_ACCESS.md
git rm $(git ls-files 'test/*' | xargs grep -ln "from '../server/" || true)
```

- [ ] **Step 3: Strip the dead dependencies**

```bash
npm uninstall express multer archiver fluent-ffmpeg prom-client dotenv \
  @types/express @types/multer @types/archiver @ffprobe-installer/ffprobe
```

Keep `@ffmpeg-installer/ffmpeg` — Step 1 of Task 2 copies its binary into `src-tauri/binaries`.

Remove the `"server"` script from `package.json`.

- [ ] **Step 4: Rewrite the docs**

`README.md` becomes: what the app is, how to run it in dev (`npm run app:dev`), how to build it (`npm run app:build`), where the output lands, and the two length modes.

`HANDOFF.md` loses the deployment and auth sections entirely — they described a server that no longer exists, including the `/api/auth/session` hole. Add instead: the Rust toolchain requirement, the SmartScreen warning on an unsigned exe, and where the ffmpeg sidecar comes from.

- [ ] **Step 5: Run everything**

```bash
npm test
npx tsc --noEmit
npm run app:dev
```

Expected: tests green, no type errors, the app still opens and renders.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: delete the web half

Nothing has imported any of this since the queue moved into the webview.
Express, multer, archiver, the temp store, the download tokens, the job
persistence, the auth session, the Prometheus endpoint, the Docker and
nginx and GCloud deployment -- all of it existed to put this tool on a
machine that was not yours.

The auth session goes with particular satisfaction: /api/auth/session
handed a valid session to anyone who asked, and the repo shipped a
GCloud deploy script right next to it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Build the exe and prove it works cold

**Files:**
- Modify: `README.md`
- Create: `test/smoke-real-render.test.ts`

**Interfaces:**
- Produces: `src-tauri/target/release/bundle/nsis/Resize Video_2.0.0_x64-setup.exe`

- [ ] **Step 1: Write a real-media smoke test**

Create `test/smoke-real-render.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { planBatch } from '../src/core/renderPlan.ts';
import { argvFor } from '../src/render/runBatch.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const run = promisify(execFile);
const ffmpeg = ffmpegInstaller.path;

test('a planned batch really produces playable files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resize-smoke-'));
  const input = join(dir, 'source.mp4');

  // 20s of colour bars at 1080x1920, so the 15s tier is offered and 30s is not.
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=20:size=1080x1920:rate=30',
                     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);

  const source: ResizeBatchSource = {
    localId: '0:' + input, path: input, filename: 'source.mp4',
    duration: 20, inputRatio: '9:16',
    gameName: 'Smoke', version: 'v1', suffix: '',
  };

  const spec = {
    fgPosition: 'center' as const, bgType: 'video' as const,
    backgroundSource: 'self' as const, backgroundImageMode: 'clean' as const,
    blurAmount: 24, bitrate: 2000,
    logoX: 0, logoY: 0, logoSize: 100,
    buttonType: 'text' as const, buttonText: '', buttonX: 0, buttonY: 0, buttonSize: 100,
  };

  const jobs = planBatch([source], new Set(['9:16-15s']), 'speed');
  assert.deepEqual(jobs.map((job) => job.kind), ['composite', 'speed']);

  for (const job of jobs) {
    await run(ffmpeg, argvFor(job, source, dir, spec, 2), { maxBuffer: 8 * 1024 * 1024 });
    const written = await stat(join(dir, job.filename));
    assert.ok(written.size > 0, `${job.filename} is empty`);
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test test/smoke-real-render.test.ts`
Expected: PASS. This is slow — around a minute — and it is the only test that runs ffmpeg for real.

- [ ] **Step 3: Build the installer**

Run: `npm run app:build`
Expected: an NSIS installer under `src-tauri/target/release/bundle/nsis/`.

- [ ] **Step 4: Measure it against the spec's promise**

```bash
ls -lh "src-tauri/target/release/bundle/nsis/"*.exe | awk '{print $5, $9}'
```

Expected: roughly 60–75 MB. Materially larger means `ffprobe` or a second ffmpeg crept back into `src-tauri/binaries`.

- [ ] **Step 5: Install and run it cold**

Install on a machine that has never had the dev environment. Then:
- Render one video to two ratios; confirm the files open in Windows Media Player.
- Confirm no console window appears behind the app.
- Close the app mid-render, then run `Get-Process ffmpeg` — expect nothing.
- Note the exact SmartScreen wording so the README can tell the team what to expect.

- [ ] **Step 6: Commit**

```bash
git add test/smoke-real-render.test.ts README.md
git commit -m "$(cat <<'EOF'
test: render real media through the real plan

Everything else in the suite tests a decision. This one runs ffmpeg,
writes files and checks they are not empty, which is the only way to
catch an argv that is well-formed and still wrong.

It uses a generated 20s source so the 15s tier is offered and the 30s one
is not -- the plan's gating is part of what is being proved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

**Spec coverage checked:** scope (Task 15) · direct-disk flow (Tasks 4, 13) · dual length mode (Task 6) · batch with version increment (Task 10) · two background kinds (Task 13, 14) · naming config (Tasks 10, 12) · logo/CTA hidden by default (Tasks 12, 14) · single preview (Task 14) · layout A (Task 14) · original copied and normalised (Task 11) · repo becomes desktop (Task 15) · process registry (Task 2) · error table (Tasks 8, 9, 12, 14) · test strategy (every task, plus 16).

**Known gaps left deliberately:** the overwrite dialog's visual design is left to the implementer; the `Advanced` panel reuses the existing logo/CTA controls verbatim rather than redesigning them.

**Three names to confirm against the code before trusting them.** This plan was written from the exports it could read, and these three were inferred:

| Used in the plan | Where to check | What to do |
|---|---|---|
| `probeFgDuration(url)` | `src/core/fgDuration.ts` | Use whatever the real probe entry point is called; the plan only needs the `{ status, duration, width, height }` shape, which is confirmed |
| `validateBatchNaming(sources)` returning a falsy value when valid | `src/core/batchNaming.ts` | If it returns a list or throws instead, adapt the two call sites in Task 14 |
| `parseVideoNamingMeta('HeroWars_v3_UGC.mp4')` yielding `gameName: 'HeroWars', version: 'v3'` | `src/core/naming.ts` | Run the parser once and write the test in Task 10 Step 1 against what it actually returns — do not change the parser to fit the test |

**Fixed during self-review:** `RenderSpecBase` was missing the two background paths `argvFor` reads, so Task 13 would not have compiled. `parentFilename` was introduced after the code that consumes it; it now comes first. The thread-cap test asserted on the bare string `"2"`, which any blur amount or bitrate could satisfy. Two rows of the spec's error table — an unwritable output folder and a source that vanished — had no task at all, and are now Task 14 Steps 4–5.
