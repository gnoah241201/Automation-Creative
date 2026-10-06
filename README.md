# Resize Video

A Windows desktop app that turns a folder of ad videos into the aspect ratios and
lengths an ad network asks for, and writes them straight into a folder you pick.

Drop videos in, tick the ratios (9:16, 16:9, 4:5, 2:3, 1:1) and lengths you want,
choose an output folder, press Render. There is no server, no upload and no login:
the files are read where they sit and ffmpeg runs on your own machine. The
interface text is Vietnamese.

Built with Tauri 2 (Rust shell) + React/Vite. Rendering is done by an ffmpeg
binary bundled with the app as a sidecar.

## Run it in development

Prerequisites (details and the traps in [HANDOFF.md](HANDOFF.md)):

- Windows 10 or 11, x64
- Node.js 22 or newer
- Rust, stable, **MSVC** toolchain (`rustup default stable-x86_64-pc-windows-msvc`)
- Visual Studio Build Tools with the C++ workload **and a Windows SDK**

```bash
npm install
npm run app:dev
```

`app:dev` first runs `npm run prepare:ffmpeg`, which copies the ffmpeg binary out of
`node_modules` into `src-tauri/binaries/` (see below), then starts Vite on port 8080
and opens the app window. The first run compiles the Rust side and takes a few minutes;
later runs are quick.

## Build the installer

```bash
npm run app:build
```

This runs the same ffmpeg step, builds the web bundle, compiles the Rust side in
release mode and packages an NSIS installer. Tauri's standard location for it is
(this has not been run from a clean checkout yet; see HANDOFF.md):

```
src-tauri/target/release/bundle/nsis/
```

named from `productName` and `version` in `src-tauri/tauri.conf.json`
(`Resize Video_<version>_x64-setup.exe`). The installer version comes from that file,
not from `package.json`.

The installer is **not code-signed**. Windows SmartScreen will warn
("Windows protected your PC") the first time anyone runs it: choose
*More info*, then *Run anyway*. Signing needs a certificate this repo does not have.

## Where the output lands

Everything is written into the folder chosen in the app ("Thư mục lưu"). It is created
if it does not exist, and the app refuses to start a run if it cannot write there.

- Each output is named `<Game>_<Version>_<ratio>[_<N>s]_<Suffix>.mp4`, for example
  `BubbleTea_v60_9x16_15s_TTO.mp4`. The three naming fields are read from the source
  filename and can be overridden for the whole batch.
- Each source's **original** is copied into the same folder, named from the same
  fields plus the source's own ratio and length. A source that is not h264 in an mp4
  container is converted to h264 first, so the copy opens on any machine; that copy is
  therefore a re-encode, not byte-identical.
- A file is written as `<name>.mp4.part` and renamed only when ffmpeg finishes
  successfully, so a cancelled or failed render never leaves a truncated file under a
  real name. A `.part` file left behind means a render was killed; delete it.
- If a name already exists in the folder, the app asks: overwrite, skip, bump the
  version, or cancel.

## The two length modes

Chosen in the settings panel; the default is **speed**.

| Mode | What a shorter output is | Lengths offered |
|---|---|---|
| **speed** (default) | The *whole* video retimed (video and audio) to end at N seconds. Nothing is left out. | 15s, 30s |
| **cut** | The first N seconds of the full-length output, stream-copied. | 6, 10, 12, 15, 30, 60, 90, 120s |

A length is offered only when the source is longer than it (speed mode needs half a
second of margin). So a 20s clip has a 15s output but no 30s one, and a batch of mixed
lengths offers each source only what it can fill.

Either way each ratio is composited once; the shorter lengths are derived from that
composite, so ticking more lengths costs a retime or a copy, not another full render.
In cut mode the full-length file is dropped when the longest cut already covers the
source to within a second. Cut lengths come from a stream copy, so they can be off by up
to one keyframe interval.

## Tests

```bash
npm test          # TypeScript: node:test via tsx
npm run lint      # tsc --noEmit
cd src-tauri && cargo test
```

`test/output-derivation.test.ts` is the executable spec for which outputs exist.

## Where to read next

[HANDOFF.md](HANDOFF.md): toolchain traps, how the ffmpeg sidecar gets there, how the
code is laid out, known limitations.
