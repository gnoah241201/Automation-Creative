import { AlertTriangle, FolderOpen, Loader2, X } from 'lucide-react';
import { ResizeBatchSource } from '../core/librarySources';

/** 42.4 -> "0:42", 3725 -> "1:02:05". A duration that never arrived is a dash. */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

interface SourceDropProps {
  sources: ResizeBatchSource[];
  /** Why a source's length could not be read, by position. Undefined when it could. */
  warnings: Array<string | undefined>;
  probing: { done: number; total: number } | null;
  /** True while files are being dragged over the window. */
  dragging: boolean;
  disabled: boolean;
  onPick: () => void;
  onClear: () => void;
  onRemove: (localId: string) => void;
}

export function SourceDrop({
  sources, warnings, probing, dragging, disabled, onPick, onClear, onRemove,
}: SourceDropProps) {
  return (
    <section aria-label="Video nguồn" className="space-y-3">
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className={`w-full rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors disabled:opacity-60 ${dragging
          ? 'border-blue-400 bg-blue-500/10'
          : 'border-neutral-700 bg-neutral-900/40 hover:border-neutral-500 hover:bg-neutral-900'}`}
      >
        {probing ? (
          <span className="inline-flex items-center gap-2 text-neutral-200">
            <Loader2 className="h-5 w-5 animate-spin" />
            Đang đọc độ dài video {probing.done}/{probing.total}
          </span>
        ) : (
          <>
            <FolderOpen className="mx-auto mb-2 h-7 w-7 text-neutral-400" />
            <span className="block text-base font-medium text-neutral-100">
              {sources.length === 0 ? 'Kéo thả video vào đây, hoặc bấm để chọn' : 'Thả thêm video, hoặc bấm để chọn thêm'}
            </span>
            <span className="mt-1 block text-sm text-neutral-400">
              {sources.length === 0 ? 'Chọn được nhiều video một lúc' : `Đã chọn ${sources.length} video`}
            </span>
          </>
        )}
      </button>

      {sources.length > 0 && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40">
          <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800">
            <span className="text-sm font-medium text-neutral-200">{sources.length} video</span>
            <button
              type="button"
              onClick={onClear}
              disabled={disabled}
              className="text-xs text-neutral-400 hover:text-white disabled:opacity-50"
            >
              Xóa tất cả
            </button>
          </div>
          <ul className="max-h-56 overflow-y-auto divide-y divide-neutral-800/70">
            {sources.map((source, index) => {
              const warning = warnings[index];
              return (
                <li key={source.localId} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid="source-row">
                  <span className="min-w-0 flex-1 truncate text-neutral-100" title={source.path}>{source.filename}</span>
                  {warning && (
                    <span
                      className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300"
                      title={`${warning}. Video này chỉ có bản full-length.`}
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Không đọc được độ dài
                    </span>
                  )}
                  <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300" title="Tỉ lệ nguồn">
                    {source.inputRatio}
                  </span>
                  <span
                    className="w-16 text-right tabular-nums text-neutral-300"
                    title={Number.isFinite(source.duration) ? `${source.duration.toFixed(2)} giây` : 'Không đọc được'}
                    data-testid="source-duration"
                  >
                    {formatDuration(source.duration)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(source.localId)}
                    disabled={disabled}
                    aria-label={`Bỏ ${source.filename}`}
                    className="text-neutral-500 hover:text-white disabled:opacity-40"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
