import { AlertCircle, Ban, CheckCircle2, Circle, Loader2, MinusCircle } from 'lucide-react';
import { ResizeBatchSource } from '../core/librarySources';
import { PlannedJob } from '../core/renderPlan';
import { JobState } from '../core/renderQueue';
import { statusOf, summarize } from '../render/jobStatus';

interface JobListProps {
  plan: PlannedJob[];
  sources: ResizeBatchSource[];
  states: ReadonlyMap<string, JobState>;
  errors: ReadonlyMap<string, string>;
  /** 0-100 per job id, for the jobs ffmpeg has reported a timestamp on. */
  progress: ReadonlyMap<string, number>;
  running: boolean;
  /** "Chép bản gốc 3/20" while the originals are being put in place. */
  phaseNote: string | null;
  stopping: boolean;
  onCancel: (jobId: string) => void;
  onStopAll: () => void;
  onDismiss: () => void;
}

const labelOf = (job: PlannedJob) => `${job.ratio}${job.duration ? ` · ${Math.round(job.duration)}s` : ' · full'}`;

const KIND_NOTE: Record<PlannedJob['kind'], string> = {
  composite: 'dựng',
  trim: 'cắt',
  speed: 'tua nhanh',
};

export function JobList({
  plan, sources, states, errors, progress, running, phaseNote, stopping, onCancel, onStopAll, onDismiss,
}: JobListProps) {
  const byId = new Map(sources.map((source) => [source.localId, source]));
  const summary = summarize(plan.map((job) => job.id), states, errors);

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40" aria-label="Tiến độ">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-800 px-4 py-3 text-sm">
        <span className="font-semibold text-neutral-100">
          {running ? 'Đang render' : 'Kết quả'} · {summary.done}/{summary.total} xong
        </span>
        {summary.failed > 0 && <span className="text-red-400">{summary.failed} lỗi</span>}
        {summary.skipped > 0 && <span className="text-amber-300">{summary.skipped} bỏ qua</span>}
        {summary.cancelled > 0 && <span className="text-neutral-400">{summary.cancelled} đã hủy</span>}
        {phaseNote && <span className="text-blue-300">{phaseNote}</span>}
        <span className="ml-auto flex items-center gap-3">
          {running ? (
            <button
              type="button"
              onClick={onStopAll}
              disabled={stopping}
              className="rounded-lg border border-neutral-600 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-800 disabled:opacity-50"
            >
              {stopping ? 'Đang dừng…' : 'Dừng tất cả'}
            </button>
          ) : (
            <button type="button" onClick={onDismiss} className="text-xs text-neutral-400 hover:text-white">Ẩn kết quả</button>
          )}
        </span>
      </div>

      {!running && summary.failed + summary.cancelled > 0 && (
        <p className="border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
          Job lỗi hoặc đã hủy có thể để lại file dở dang trong thư mục. Chạy lại sẽ ghi đè lên file đó.
        </p>
      )}

      <ul className="max-h-96 divide-y divide-neutral-800/70 overflow-y-auto" data-testid="job-list">
        {plan.map((job) => {
          const state = states.get(job.id);
          const error = errors.get(job.id);
          const status = statusOf(state, error);
          const source = byId.get(job.sourceId);
          const percent = progress.get(job.id);
          return (
            <li key={job.id} className="px-4 py-2 text-sm" data-status={status} data-testid="job-row">
              <div className="flex items-center gap-3">
                <StatusIcon status={status} />
                <span className="min-w-0 flex-1 truncate text-neutral-100" title={job.filename}>
                  {source?.filename ?? job.sourceId} <span className="text-neutral-500">· {labelOf(job)} · {KIND_NOTE[job.kind]}</span>
                </span>
                {status === 'running' && (
                  <>
                    <span className="w-10 text-right text-xs tabular-nums text-neutral-400">
                      {percent === undefined ? '' : `${Math.floor(percent)}%`}
                    </span>
                    <button type="button" onClick={() => onCancel(job.id)} className="text-xs text-neutral-400 hover:text-white">Hủy</button>
                  </>
                )}
                {status === 'done' && <span className="text-xs text-green-400">Xong</span>}
                {status === 'waiting' && <span className="text-xs text-neutral-500">Chờ</span>}
                {status === 'cancelled' && <span className="text-xs text-neutral-400">Đã hủy</span>}
                {status === 'skipped' && <span className="text-xs text-amber-300">Bỏ qua</span>}
                {status === 'failed' && <span className="text-xs text-red-400">Lỗi</span>}
              </div>
              {status === 'running' && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className={`h-full rounded-full bg-blue-500 transition-[width] duration-300 ${percent === undefined ? 'w-1/4 animate-pulse' : ''}`}
                    style={percent === undefined ? undefined : { width: `${percent}%` }}
                  />
                </div>
              )}
              {status === 'skipped' && (
                <p className="mt-1 text-xs text-amber-300/80">Bản dùng làm nguồn cho nó chưa có, nên chưa chạy.</p>
              )}
              {status === 'failed' && error && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-red-300">{error.split('\n')[0]}</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 text-[11px] text-red-200/90">{error}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatusIcon({ status }: { status: ReturnType<typeof statusOf> }) {
  const cls = 'h-4 w-4 shrink-0';
  switch (status) {
    case 'running': return <Loader2 className={`${cls} animate-spin text-blue-400`} />;
    case 'done': return <CheckCircle2 className={`${cls} text-green-400`} />;
    case 'failed': return <AlertCircle className={`${cls} text-red-400`} />;
    case 'cancelled': return <Ban className={`${cls} text-neutral-400`} />;
    case 'skipped': return <MinusCircle className={`${cls} text-amber-300`} />;
    default: return <Circle className={`${cls} text-neutral-600`} />;
  }
}
