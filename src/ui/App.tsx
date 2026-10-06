import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, Info, Play, RefreshCw, RotateCcw, Settings as SettingsIcon, X } from 'lucide-react';
import { getBridge, VIDEO_EXTENSIONS } from '../bridge/tauri';
import { buildOutputFilename } from '../naming';
import { AspectRatio } from '../core/contract';
import { collidingOriginals, nameOriginals, NamedOriginal } from '../core/batchOriginals';
import { deriveBatchOutputCatalog, deriveSourceOutputs } from '../core/batchOutputs';
import { validateBatchNaming } from '../core/batchNaming';
import { basename, buildBatchSources, nextConfigVersion } from '../core/batchSources';
import { ResizeBatchSource } from '../core/librarySources';
import {
  clearNamingConfig, emptyNamingConfig, loadNamingConfig, lockNamingConfig, saveNamingConfig, NamingConfig,
} from '../core/naming/namingConfig';
import { NamingMeta } from '../core/contract';
import { RATIOS } from '../core/outputDerivation';
import { dropColliding, findCollisions } from '../core/outputCollision';
import { progressPercent } from '../core/progressParse';
import { planBatch, planRetry, PlannedJob, reopenMissingParents } from '../core/renderPlan';
import { JobState } from '../core/renderQueue';
import { loadSettings, Settings, writeSettings } from '../core/settings';
import { copyOriginals } from '../render/copyOriginals';
import { summarize } from '../render/jobStatus';
import { join, RenderSpecBase, runBatch } from '../render/runBatch';
import {
  AdvancedState, BackgroundState, buildSpecBase, DEFAULT_ADVANCED, DEFAULT_BACKGROUND,
} from '../render/specBase';
import { AdvancedPanel } from './AdvancedPanel';
import { BackgroundChoice } from './BackgroundChoice';
import { JobList } from './JobList';
import { NamingFields } from './NamingFields';
import { OutputFolderField } from './OutputFolderField';
import { OutputMatrix } from './OutputMatrix';
import { OverwriteChoice, OverwriteDialog } from './OverwriteDialog';
import { overlayKey, prepareOverlays } from './overlays';
import { PreviewPane } from './PreviewBox';
import { PickedSource, probeAll } from './probeSources';
import { SettingsPanel } from './SettingsPanel';
import { SourceDrop } from './SourceDrop';

/**
 * Everything a retry needs to repeat a run exactly.
 *
 * Snapshotted when the run starts, so a naming edit, a removed source or a mode
 * switch made afterwards cannot make "retry" do something other than what
 * failed. In particular `plan` is the plan that was run, never a fresh one.
 */
interface RunSnapshot {
  sources: ResizeBatchSource[];
  plan: PlannedJob[];
  selected: ReadonlySet<string>;
  mode: Settings['lengthMode'];
  spec: RenderSpecBase;
  folder: string;
  overlays: ReadonlyMap<string, string>;
}

const isVideoPath = (path: string): boolean => {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.includes(extension);
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How long the job's output is, which is what ffmpeg's `time=` counts toward. */
const totalSecondsFor = (job: PlannedJob, source: ResizeBatchSource | undefined): number =>
  job.duration ?? source?.duration ?? Number.NaN;

const lower = (names: string[]) => new Set(names.map((name) => name.toLowerCase()));

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings(navigator.hardwareConcurrency || 4));
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [namingConfig, setNamingConfig] = useState<NamingConfig>(() => loadNamingConfig(window.localStorage));
  const [probed, setProbed] = useState<PickedSource[]>([]);
  const [probing, setProbing] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewRatio, setPreviewRatio] = useState<AspectRatio | null>(null);
  const [background, setBackground] = useState<BackgroundState>(DEFAULT_BACKGROUND);
  const [advanced, setAdvanced] = useState<AdvancedState>(DEFAULT_ADVANCED);

  const [runView, setRunView] = useState<{ plan: PlannedJob[]; sources: ResizeBatchSource[] } | null>(null);
  const [jobs, setJobs] = useState<ReadonlyMap<string, JobState>>(new Map());
  const [jobErrors, setJobErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [progress, setProgress] = useState<ReadonlyMap<string, number>>(new Map());
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [phaseNote, setPhaseNote] = useState<string | null>(null);
  const [pendingOriginals, setPendingOriginals] = useState<NamedOriginal[]>([]);
  // How many originals actually failed to copy, as opposed to merely not having
  // been reached because the run was stopped. Only the first is a "lỗi".
  const [failedOriginalCount, setFailedOriginalCount] = useState(0);
  const [finishedFolder, setFinishedFolder] = useState<string | null>(null);

  const [blockingError, setBlockingError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState<{
    names: string[]; bumpTo: string | null; resolve: (choice: OverwriteChoice) => void;
  } | null>(null);

  const mode = settings.lengthMode;

  // The batch is derived from what was picked plus the naming config, so
  // editing the naming rewrites every name at once and removing a video counts
  // the versions up again without anyone re-picking anything.
  const sources = useMemo(() => buildBatchSources(probed, namingConfig), [probed, namingConfig]);
  const catalog = useMemo(() => deriveBatchOutputCatalog(sources, mode), [sources, mode]);
  const plan = useMemo(() => planBatch(sources, selected, mode), [sources, selected, mode]);
  const specBase = useMemo(() => buildSpecBase(background, advanced), [background, advanced]);

  const tickedRatios = useMemo(
    () => new Set(catalog.filter((output) => selected.has(output.id)).map((output) => output.ratio)),
    [catalog, selected],
  );
  const effectivePreviewRatio: AspectRatio = previewRatio ?? RATIOS.find((ratio) => tickedRatios.has(ratio)) ?? '9:16';

  const namingPreview = useMemo(() => {
    const first = sources[0];
    if (!first) return null;
    const [leading] = deriveSourceOutputs(first, mode);
    return buildOutputFilename(
      { gameName: first.gameName || 'untitled', version: first.version || 'v1', suffix: first.suffix },
      leading?.ratio ?? '9:16',
      leading?.duration,
    );
  }, [sources, mode]);

  // --- refs that async handlers read, so they never act on a stale render ---
  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const probedRef = useRef(probed);
  probedRef.current = probed;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const probingPaths = useRef(new Set<string>());
  const runRef = useRef<RunSnapshot | null>(null);
  const statesRef = useRef(new Map<string, JobState>());
  const errorsRef = useRef(new Map<string, string>());
  const progressRef = useRef(new Map<string, number>());
  const progressDirty = useRef(false);
  const totalsRef = useRef(new Map<string, number>());
  const originalsRef = useRef<NamedOriginal[]>([]);

  // --- persistence ---
  useEffect(() => { saveNamingConfig(window.localStorage, namingConfig); }, [namingConfig]);

  const patchSettings = (change: Partial<Settings>) => setSettings((previous) => {
    const next = { ...previous, ...change };
    writeSettings(next);
    return next;
  });

  // --- adding videos: the button and the window drop share one path ---
  const addPaths = useCallback(async (paths: string[]) => {
    if (runningRef.current) return;
    const videos = paths.filter(isVideoPath);
    const ignored = paths.length - videos.length;
    const known = new Set([
      ...probedRef.current.map((item) => item.path.toLowerCase()),
      ...probingPaths.current,
    ]);
    const fresh: string[] = [];
    for (const path of videos) {
      const key = path.toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      fresh.push(path);
    }
    setNotices(ignored > 0 ? [`Bỏ qua ${ignored} file không phải video.`] : []);
    if (fresh.length === 0) return;

    for (const path of fresh) probingPaths.current.add(path.toLowerCase());
    setProbing({ done: 0, total: fresh.length });
    try {
      const results = await probeAll(fresh, (done, total) => setProbing({ done, total }));
      const next = [...probedRef.current, ...results];
      setProbed(next);

      // First batch: tick the full-length output of every ratio. That is the
      // set people nearly always want, and the rest is one click away.
      if (selectedRef.current.size === 0) {
        const firstSources = buildBatchSources(next, namingConfig);
        const defaults = deriveBatchOutputCatalog(firstSources, settingsRef.current.lengthMode)
          .filter((output) => output.duration === undefined)
          .map((output) => output.id);
        setSelected(new Set(defaults));
      }
      setPreviewPath((current) => current ?? results[0]?.path ?? null);
    } finally {
      for (const path of fresh) probingPaths.current.delete(path.toLowerCase());
      setProbing(null);
    }
  }, [namingConfig]);
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;

  const handlePick = async () => {
    try {
      const paths = await getBridge().pickVideos();
      if (paths.length > 0) await addPaths(paths);
    } catch (error) {
      setBlockingError(`Không mở được hộp thoại chọn video. ${describe(error)}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    getBridge().onFileDrop((event) => {
      if (event.kind === 'over') setDragging(true);
      else if (event.kind === 'leave') setDragging(false);
      else {
        setDragging(false);
        void addPathsRef.current(event.paths);
      }
    }).then((stop) => {
      if (cancelled) stop(); else unlisten = stop;
    }).catch(() => { /* outside a Tauri window there is no drop to listen for */ });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const removeSource = (localId: string) => {
    const index = sources.findIndex((source) => source.localId === localId);
    if (index >= 0) setProbed((current) => current.filter((_, at) => at !== index));
  };

  const clearSources = () => {
    setProbed([]);
    setPreviewPath(null);
    setSelected(new Set());
  };

  // --- selection ---
  const toggleOutput = (id: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleMany = (ids: string[], on: boolean) => setSelected((previous) => {
    const next = new Set(previous);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });

  // --- naming ---
  const editNaming = (patch: Partial<NamingMeta>) => setNamingConfig((current) => lockNamingConfig(current, patch));
  const resetNaming = () => {
    clearNamingConfig(window.localStorage);
    setNamingConfig(emptyNamingConfig());
  };

  // --- background and advanced ---
  const pickBanner = async () => {
    try {
      const path = await getBridge().pickImage();
      if (path) setBackground((current) => ({ ...current, kind: 'banner', bannerPath: path }));
    } catch (error) {
      setBlockingError(`Không mở được hộp thoại chọn ảnh. ${describe(error)}`);
    }
  };
  const chooseBanner = () => {
    if (background.bannerPath) setBackground((current) => ({ ...current, kind: 'banner' }));
    else void pickBanner();
  };
  const pickLogo = async () => {
    try {
      const path = await getBridge().pickImage();
      if (path) setAdvanced((current) => ({ ...current, logoPath: path }));
    } catch (error) {
      setBlockingError(`Không mở được hộp thoại chọn ảnh. ${describe(error)}`);
    }
  };
  const pickFolder = async () => {
    try {
      const folder = await getBridge().pickFolder();
      if (folder) patchSettings({ outputFolder: folder });
    } catch (error) {
      setBlockingError(`Không mở được hộp thoại chọn thư mục. ${describe(error)}`);
    }
  };

  // --- progress: events arrive many times a second per job, the screen does not need to ---
  const handleProgressLine = (jobId: string, line: string) => {
    const total = totalsRef.current.get(jobId);
    if (total === undefined) return;
    const percent = progressPercent(line, total);
    if (percent === null) return;
    progressRef.current.set(jobId, percent);
    progressDirty.current = true;
  };
  const flushProgress = () => {
    if (!progressDirty.current) return;
    progressDirty.current = false;
    setProgress(new Map(progressRef.current));
  };
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(flushProgress, 300);
    return () => window.clearInterval(timer);
  }, [running]);

  const syncJobs = () => {
    setJobs(new Map(statesRef.current));
    setJobErrors(new Map(errorsRef.current));
  };

  // --- running ---
  const askOverwrite = (names: string[], bumpTo: string | null) =>
    new Promise<OverwriteChoice>((resolve) => setOverwrite({ names, bumpTo, resolve }));

  /**
   * Drops sources that vanished from disk since they were picked, and says
   * which. A batch can sit on screen for an hour while someone tidies the
   * folder it came from.
   */
  const dropGoneSources = async (list: ResizeBatchSource[]): Promise<ResizeBatchSource[]> => {
    const gone = await getBridge().missingPaths(list.map((source) => source.path));
    if (gone.length === 0) return list;
    const goneSet = new Set(gone);
    setNotices((current) => [
      ...current,
      `Bỏ qua ${gone.length} video không còn trên đĩa: ${gone.map(basename).join(', ')}`,
    ]);
    return list.filter((source) => !goneSet.has(source.path));
  };

  const startRun = async (
    snapshot: RunSnapshot,
    toRun: PlannedJob[],
    options: { baseStates: ReadonlyMap<string, JobState>; alreadyDone: ReadonlySet<string>; originals: NamedOriginal[] },
  ) => {
    runningRef.current = true;
    stopRef.current = false;
    setRunning(true);
    setStopping(false);
    setPhaseNote(null);
    setFinishedFolder(null);

    runRef.current = snapshot;
    originalsRef.current = options.originals;
    const states = new Map(options.baseStates);
    for (const job of toRun) {
      states.set(job.id, 'waiting');
      errorsRef.current.delete(job.id);
      progressRef.current.delete(job.id);
    }
    statesRef.current = states;
    const sourceById = new Map(snapshot.sources.map((source) => [source.localId, source]));
    totalsRef.current = new Map(snapshot.plan.map((job) => [job.id, totalSecondsFor(job, sourceById.get(job.sourceId))]));
    setRunView({ plan: snapshot.plan, sources: snapshot.sources });
    progressDirty.current = true;
    flushProgress();
    syncJobs();

    let unlisten: () => void = () => {};
    try {
      unlisten = await getBridge().onProgress(handleProgressLine);
    } catch {
      // Progress bars are cosmetic; the render does not need them.
    }

    try {
      await runBatch({
        sources: snapshot.sources,
        selectedIds: snapshot.selected,
        mode: snapshot.mode,
        outputFolder: snapshot.folder,
        spec: snapshot.spec,
        concurrency: settingsRef.current.concurrency,
        plan: toRun,
        alreadyDone: options.alreadyDone,
        shouldStop: () => stopRef.current,
        overlayFor: (input, output) => snapshot.overlays.get(overlayKey(input, output)),
        onChange: (id, state, error) => {
          statesRef.current.set(id, state);
          if (state === 'failed' && error) errorsRef.current.set(id, error);
          else if (state !== 'failed') errorsRef.current.delete(id);
          syncJobs();
        },
      });

      if (stopRef.current) {
        // A stopped run did not finish, so its originals are still owed.
        setPendingOriginals(options.originals);
        setFailedOriginalCount(0);
      } else if (options.originals.length > 0) {
        setPhaseNote(`Chép bản gốc 0/${options.originals.length}`);
        const { failed, notReached } = await copyOriginals(options.originals, snapshot.folder, {
          onStep: (done, total) => setPhaseNote(`Chép bản gốc ${done}/${total}`),
          shouldStop: () => stopRef.current,
        });
        // Stopping during this phase kills the conversion in flight, which then
        // reports as failed. That is the user's doing, not a fault to list.
        const genuine = stopRef.current ? [] : failed;
        setPendingOriginals([...failed.map((entry) => entry.item), ...notReached]);
        setFailedOriginalCount(genuine.length);
        if (genuine.length > 0) {
          setNotices((current) => [
            ...current,
            `Không chép được bản gốc của ${genuine.length} video: ${genuine.map((entry) => `${entry.item.source.filename}: ${entry.message}`).join('; ')}`,
          ]);
        }
      } else {
        setPendingOriginals([]);
        setFailedOriginalCount(0);
      }
      setFinishedFolder(snapshot.folder);
    } catch (error) {
      setBlockingError(`Lỗi khi chạy: ${describe(error)}`);
    } finally {
      unlisten();
      progressDirty.current = true;
      flushProgress();
      syncJobs();
      runningRef.current = false;
      setRunning(false);
      setStopping(false);
      setPhaseNote(null);
    }
  };

  const handleRender = async () => {
    const folder = settings.outputFolder;
    if (!folder || runningRef.current) return;
    setBlockingError(null);
    setNotices([]);

    if (background.kind === 'banner' && !background.bannerPath) {
      setBlockingError('Chưa chọn ảnh banner.');
      return;
    }

    // 1. Hard block: a shared version renders every video to one filename.
    const namingErrors = validateBatchNaming(sources);
    if (namingErrors.length > 0) {
      setBlockingError(namingErrors.join('\n'));
      return;
    }

    const bridge = getBridge();

    // 2. Hard block: no point starting 120 renders that cannot be written.
    // This also creates the folder, which neither runBatch nor ffmpeg does.
    try {
      await bridge.checkWritable(folder);
    } catch (error) {
      setBlockingError(`Không ghi được vào ${folder}. ${describe(error)}`);
      return;
    }

    // 3. Drop sources that vanished while the batch sat on screen.
    let live: ResizeBatchSource[];
    try {
      live = await dropGoneSources(sources);
    } catch (error) {
      setBlockingError(`Không kiểm tra được file nguồn. ${describe(error)}`);
      return;
    }
    if (live.length === 0) {
      setBlockingError('Không còn video nguồn nào trên đĩa.');
      return;
    }

    let plannedJobs = planBatch(live, selected, mode);
    if (plannedJobs.length === 0) {
      setBlockingError('Không có output nào để render: các ô đã chọn không áp dụng được cho video còn lại.');
      return;
    }

    // 4. Soft warn: the folder is the record of what has been rendered. The
    // originals are checked with the outputs, because the copy that puts them
    // there overwrites silently and findCollisions only sees planned jobs.
    const originals = nameOriginals(live, plannedJobs);
    let originalsToCopy = originals.named;
    if (originals.withheld.length > 0) {
      setNotices((current) => [...current, `Không có bản gốc cho: ${originals.withheld.join('; ')}`]);
    }
    let existing: string[];
    try {
      existing = await bridge.listFiles(folder);
    } catch (error) {
      setBlockingError(`Không đọc được thư mục ${folder}. ${describe(error)}`);
      return;
    }
    const jobCollisions = findCollisions(plannedJobs, existing);
    const originalCollisions = collidingOriginals(originalsToCopy, existing);
    if (jobCollisions.length + originalCollisions.length > 0) {
      const choice = await askOverwrite(
        [...jobCollisions, ...originalCollisions.map((hit) => hit.filename)],
        nextConfigVersion(namingConfig, sources.length),
      );
      if (choice === 'cancel') return;
      if (choice === 'bump') {
        const bumped = nextConfigVersion(namingConfig, sources.length);
        if (bumped) {
          setNamingConfig((current) => ({ ...current, version: bumped }));
          setNotices([`Đã tăng version lên ${bumped}. Bấm Render để chạy với tên mới.`]);
        }
        return;
      }
      if (choice === 'skip') {
        plannedJobs = dropColliding(plannedJobs, jobCollisions);
        const hit = new Set(originalCollisions);
        originalsToCopy = originalsToCopy.filter((item) => !hit.has(item));
      }
    }
    if (plannedJobs.length === 0 && originalsToCopy.length === 0) {
      setNotices((current) => [...current, 'Mọi file đã có sẵn trong thư mục nên không còn gì để chạy.']);
      return;
    }

    // The overlay images are drawn here, before the first job, so a logo that
    // cannot be read stops the run instead of failing sixty composites.
    let overlays: Map<string, string>;
    try {
      overlays = await prepareOverlays(live, plannedJobs, specBase, advanced);
    } catch (error) {
      setBlockingError(`Không dựng được logo/CTA. ${describe(error)}`);
      return;
    }

    const snapshot: RunSnapshot = {
      sources: live, plan: plannedJobs, selected, mode, spec: specBase, folder, overlays,
    };
    await startRun(snapshot, plannedJobs, {
      baseStates: new Map(), alreadyDone: new Set(), originals: originalsToCopy,
    });
  };

  const retryPlan = useMemo(
    () => (runView ? planRetry(runView.plan, jobs) : []),
    [runView, jobs],
  );

  const handleRetry = async () => {
    const snapshot = runRef.current;
    if (!snapshot || runningRef.current) return;
    setBlockingError(null);
    setNotices([]);
    const bridge = getBridge();

    // A retry overwrites its own earlier output, which is correct: that file is
    // the broken one. So it does not go through the overwrite prompt.
    try {
      await bridge.checkWritable(snapshot.folder);
    } catch (error) {
      setBlockingError(`Không ghi được vào ${snapshot.folder}. ${describe(error)}`);
      return;
    }

    let live: ResizeBatchSource[];
    let existing: string[];
    try {
      live = await dropGoneSources(snapshot.sources);
      existing = await bridge.listFiles(snapshot.folder);
    } catch (error) {
      setBlockingError(`Không kiểm tra được thư mục hoặc file nguồn. ${describe(error)}`);
      return;
    }
    const liveIds = new Set(live.map((source) => source.localId));

    // A finished parent whose file has since been deleted is not finished.
    const states = reopenMissingParents(snapshot.plan, statesRef.current, lower(existing));
    const toRun = planRetry(snapshot.plan, states).filter((job) => liveIds.has(job.sourceId));
    const originals = pendingOriginals.filter((item) => liveIds.has(item.source.localId));
    if (toRun.length === 0 && originals.length === 0) {
      setNotices((current) => [...current, 'Không còn gì để chạy lại.']);
      return;
    }
    const alreadyDone = new Set([...states].filter(([, state]) => state === 'done').map(([id]) => id));
    await startRun(snapshot, toRun, { baseStates: states, alreadyDone, originals });
  };

  const handleStopAll = () => {
    stopRef.current = true;
    setStopping(true);
    for (const [id, state] of statesRef.current) {
      if (state === 'running') void getBridge().cancelJob(id).catch(() => { /* already gone */ });
    }
    // An original being converted is not in the job list, but it is a running
    // ffmpeg like any other. Cancelling an id nothing runs under is a no-op.
    for (const item of originalsRef.current) {
      void getBridge().cancelJob(`original:${item.source.localId}`).catch(() => { /* not running */ });
    }
  };

  const handleCancel = (id: string) => {
    void getBridge().cancelJob(id).catch((error) => setNotices((current) => [...current, `Không hủy được job: ${describe(error)}`]));
  };

  const dismissResults = () => {
    runRef.current = null;
    statesRef.current = new Map();
    errorsRef.current = new Map();
    progressRef.current = new Map();
    setRunView(null);
    setJobs(new Map());
    setJobErrors(new Map());
    setProgress(new Map());
    setPendingOriginals([]);
    setFailedOriginalCount(0);
    setFinishedFolder(null);
  };

  const handleReveal = () => {
    if (!finishedFolder || !runView) return;
    const firstDone = runView.plan.find((job) => jobs.get(job.id) === 'done');
    const target = firstDone ? join(finishedFolder, firstDone.filename) : finishedFolder;
    void getBridge().revealFolder(target).catch((error) => setBlockingError(`Không mở được thư mục. ${describe(error)}`));
  };

  // --- what the buttons say ---
  const retryCount = retryPlan.length + pendingOriginals.length;
  const hasProblems = !running && runView !== null && retryCount > 0;
  const blockReason = (() => {
    if (sources.length === 0) return 'Chọn video trước.';
    if (selected.size === 0 || plan.length === 0) return 'Tick ít nhất một ô trong bảng xuất ra.';
    if (!settings.outputFolder) return 'Chọn thư mục lưu.';
    if (background.kind === 'banner' && !background.bannerPath) return 'Chọn ảnh banner hoặc đổi sang làm mờ chính video.';
    return null;
  })();
  const lastRunSummary = runView ? summarize(runView.plan.map((job) => job.id), jobs, jobErrors) : null;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <main className="mx-auto max-w-5xl space-y-5 p-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Resize Video</h1>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Cài đặt"
            className="rounded-lg border border-neutral-700 p-2 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            <SettingsIcon className="h-5 w-5" />
          </button>
        </header>

        <SourceDrop
          sources={sources}
          warnings={probed.map((item) => item.warning)}
          probing={probing}
          dragging={dragging}
          disabled={running}
          onPick={handlePick}
          onClear={clearSources}
          onRemove={removeSource}
        />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PreviewPane
            sources={sources}
            sourcePath={previewPath}
            onSourcePath={setPreviewPath}
            tickedRatios={tickedRatios}
            ratio={effectivePreviewRatio}
            onRatio={setPreviewRatio}
            background={background}
            fgPosition={advanced.fgPosition}
            overlay={{
              logoPath: advanced.logoPath,
              logoSize: advanced.logoSize,
              logoX: specBase.logoX,
              logoY: specBase.logoY,
              buttonText: specBase.buttonText,
              buttonSize: specBase.buttonSize,
              buttonX: specBase.buttonX,
              buttonY: specBase.buttonY,
            }}
          />
          <div className="space-y-4">
            <NamingFields
              config={namingConfig}
              onChange={editNaming}
              onReset={resetNaming}
              previewName={namingPreview}
              otherCount={Math.max(0, sources.length - 1)}
            />
            <BackgroundChoice
              source={background.kind}
              bannerPath={background.bannerPath}
              bannerMode={background.bannerMode}
              onSelf={() => setBackground((current) => ({ ...current, kind: 'self' }))}
              onBanner={chooseBanner}
              onChangeBanner={() => void pickBanner()}
              onBannerMode={(bannerMode) => setBackground((current) => ({ ...current, bannerMode }))}
            />
          </div>
        </div>

        <OutputMatrix
          catalog={catalog}
          sources={sources}
          selected={selected}
          mode={mode}
          onToggle={toggleOutput}
          onToggleMany={toggleMany}
        />

        <OutputFolderField value={settings.outputFolder} disabled={running} onPick={() => void pickFolder()} />

        <AdvancedPanel
          open={settings.advancedOpen}
          onToggle={() => patchSettings({ advancedOpen: !settings.advancedOpen })}
          value={advanced}
          onChange={(patch) => setAdvanced((current) => ({ ...current, ...patch }))}
          onPickLogo={() => void pickLogo()}
        />

        {blockingError && (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-800 bg-red-950/50 p-4 text-sm text-red-200" data-testid="blocking-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{blockingError}</p>
            <button type="button" aria-label="Đóng" onClick={() => setBlockingError(null)}><X className="h-4 w-4" /></button>
          </div>
        )}
        {notices.map((notice) => (
          <div key={notice} className="flex items-start gap-3 rounded-xl border border-amber-800/60 bg-amber-950/30 p-3 text-sm text-amber-200" data-testid="notice">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{notice}</p>
          </div>
        ))}

        {runView && (
          <JobList
            plan={runView.plan}
            sources={runView.sources}
            states={jobs}
            errors={jobErrors}
            progress={progress}
            running={running}
            phaseNote={phaseNote}
            stopping={stopping}
            onCancel={handleCancel}
            onStopAll={handleStopAll}
            onDismiss={dismissResults}
          />
        )}

        {!running && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              {hasProblems && (
                <button
                  type="button"
                  onClick={() => void handleRetry()}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-3 text-base font-semibold text-black hover:bg-amber-400"
                  data-testid="retry-button"
                >
                  <RotateCcw className="h-5 w-5" />
                  {lastRunSummary && lastRunSummary.failed + failedOriginalCount === 0
                    ? `Chạy lại ${retryCount} job chưa xong`
                    : `Chạy lại ${retryCount} job lỗi`}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleRender()}
                disabled={blockReason !== null}
                className={`inline-flex items-center gap-2 rounded-xl px-6 py-3 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${hasProblems
                  ? 'border border-neutral-600 text-neutral-100 hover:bg-neutral-800'
                  : 'bg-blue-600 text-white hover:bg-blue-500'}`}
                data-testid="render-button"
              >
                {hasProblems ? <RefreshCw className="h-5 w-5" /> : <Play className="h-5 w-5 fill-current" />}
                {hasProblems
                  ? 'Render lại từ đầu'
                  : `Render ${sources.length} video → ${plan.length + sources.length} file`}
              </button>
              {finishedFolder && (
                <button
                  type="button"
                  onClick={handleReveal}
                  className="inline-flex items-center gap-2 rounded-xl border border-neutral-600 px-4 py-3 text-sm text-neutral-100 hover:bg-neutral-800"
                >
                  <FolderOpen className="h-4 w-4" />
                  Mở thư mục kết quả
                </button>
              )}
            </div>
            {blockReason && <p className="text-xs text-neutral-500">{blockReason}</p>}
          </div>
        )}

        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            onChange={patchSettings}
            onPickFolder={() => void pickFolder()}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {overwrite && (
          <OverwriteDialog
            names={overwrite.names}
            bumpTo={overwrite.bumpTo}
            onChoose={(choice) => { overwrite.resolve(choice); setOverwrite(null); }}
          />
        )}
      </main>
    </div>
  );
}
