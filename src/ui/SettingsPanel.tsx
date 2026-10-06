import { X } from 'lucide-react';
import { LengthMode } from '../core/outputDerivation';
import { Settings } from '../core/settings';

interface SettingsPanelProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onPickFolder: () => void;
  onClose: () => void;
}

const MODES: Array<{ id: LengthMode; label: string; hint: string }> = [
  { id: 'speed', label: 'Tua nhanh', hint: 'Cả video được tua cho vừa 15s hoặc 30s. Không mất đoạn cuối.' },
  { id: 'cut', label: 'Cắt', hint: 'Giữ N giây đầu: 6, 10, 12, 15, 30, 60, 90, 120. Không encode lại.' },
];

export function SettingsPanel({ settings, onChange, onPickFolder, onClose }: SettingsPanelProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Cài đặt"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-neutral-700 bg-neutral-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Cài đặt</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="text-neutral-400 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <fieldset className="mb-5">
          <legend className="mb-2 text-sm font-medium text-neutral-200">Chế độ độ dài</legend>
          <div className="space-y-2">
            {MODES.map((mode) => (
              <label
                key={mode.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${settings.lengthMode === mode.id
                  ? 'border-blue-400 bg-blue-500/10'
                  : 'border-neutral-700 hover:bg-neutral-800'}`}
              >
                <input
                  type="radio"
                  name="length-mode"
                  value={mode.id}
                  checked={settings.lengthMode === mode.id}
                  onChange={() => onChange({ lengthMode: mode.id })}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm font-medium text-neutral-100">{mode.label}</span>
                  <span className="block text-xs text-neutral-400">{mode.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mb-5">
          <div className="mb-2 text-sm font-medium text-neutral-200">Thư mục xuất mặc định</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-300" title={settings.outputFolder ?? undefined}>
              {settings.outputFolder ?? 'Chưa chọn'}
            </div>
            <button type="button" onClick={onPickFolder} className="rounded-lg border border-neutral-600 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800">
              Đổi
            </button>
          </div>
        </div>

        <div className="mb-5">
          <label className="block text-sm font-medium text-neutral-200" htmlFor="concurrency">
            Số job chạy song song
          </label>
          <input
            id="concurrency"
            type="number"
            min={1}
            max={16}
            value={settings.concurrency}
            onChange={(event) => {
              const value = Number(event.target.value);
              // A cleared field is not a setting; keep what was there.
              if (Number.isFinite(value) && event.target.value !== '') onChange({ concurrency: Math.min(16, Math.max(1, Math.round(value))) });
            }}
            className="mt-2 w-24 rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Mặc định tính theo số core của máy này. Nhiều job hơn thì nhanh hơn nhưng máy nặng hơn.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            checked={settings.advancedOpen}
            onChange={(event) => onChange({ advancedOpen: event.target.checked })}
          />
          Mở sẵn mục Nâng cao
        </label>
      </div>
    </div>
  );
}
