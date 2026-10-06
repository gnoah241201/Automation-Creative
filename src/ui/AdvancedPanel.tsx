import { ChevronDown, ChevronRight } from 'lucide-react';
import { ForegroundPosition } from '../core/contract';
import { basename } from '../core/batchSources';
import { AdvancedState } from '../render/specBase';

interface AdvancedPanelProps {
  open: boolean;
  onToggle: () => void;
  value: AdvancedState;
  onChange: (patch: Partial<AdvancedState>) => void;
  onPickLogo: () => void;
}

const POSITIONS: Array<{ id: ForegroundPosition; label: string }> = [
  { id: 'left', label: 'Trái' },
  { id: 'center', label: 'Giữa' },
  { id: 'right', label: 'Phải' },
];

/** Logo and CTA. Closed by default and empty by default: nothing is drawn unless asked for. */
export function AdvancedPanel({ open, onToggle, value, onChange, onPickLogo }: AdvancedPanelProps) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40" aria-label="Nâng cao">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-semibold text-neutral-100"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Nâng cao
        <span className="text-xs font-normal text-neutral-500">logo, nút CTA</span>
      </button>
      {open && (
        <div className="grid gap-4 border-t border-neutral-800 px-4 py-4 sm:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Logo</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPickLogo}
                className="rounded-lg border border-neutral-600 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-800"
              >
                {value.logoPath ? 'Đổi logo' : 'Chọn logo'}
              </button>
              {value.logoPath && (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-400" title={value.logoPath}>{basename(value.logoPath)}</span>
                  <button type="button" onClick={() => onChange({ logoPath: null })} className="text-xs text-neutral-400 hover:text-white">Bỏ</button>
                </>
              )}
            </div>
            {value.logoPath && (
              <label className="block text-xs text-neutral-400">
                Cỡ logo {value.logoSize}%
                <input
                  type="range" min={20} max={200} step={5}
                  value={value.logoSize}
                  onChange={(event) => onChange({ logoSize: Number(event.target.value) })}
                  className="block w-full"
                />
              </label>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Nút CTA</h3>
            <input
              type="text"
              value={value.ctaText}
              placeholder="Để trống = không có nút (vd: Play Now)"
              onChange={(event) => onChange({ ctaText: event.target.value })}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600"
            />
            {value.ctaText.trim() && (
              <label className="block text-xs text-neutral-400">
                Cỡ nút {value.ctaSize}%
                <input
                  type="range" min={50} max={200} step={5}
                  value={value.ctaSize}
                  onChange={(event) => onChange({ ctaSize: Number(event.target.value) })}
                  className="block w-full"
                />
              </label>
            )}
          </div>

          <div className="sm:col-span-2">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Vị trí video khi dựng từ 9:16 sang 16:9
            </h3>
            <div className="flex gap-1.5" role="group" aria-label="Vị trí video">
              {POSITIONS.map((position) => (
                <button
                  key={position.id}
                  type="button"
                  aria-pressed={value.fgPosition === position.id}
                  onClick={() => onChange({ fgPosition: position.id })}
                  className={`rounded-md border px-3 py-1 text-xs ${value.fgPosition === position.id
                    ? 'border-white bg-white text-black'
                    : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'}`}
                >
                  {position.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-neutral-500">Logo và nút CTA chỉ xuất hiện ở các bản đổi giữa dọc và ngang, nơi có chỗ trống quanh video.</p>
          </div>
        </div>
      )}
    </section>
  );
}
