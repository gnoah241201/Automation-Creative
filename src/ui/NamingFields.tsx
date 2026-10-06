import { NamingMeta } from '../core/contract';
import { NamingConfig } from '../core/naming/namingConfig';

interface NamingFieldsProps {
  config: NamingConfig;
  onChange: (patch: Partial<NamingMeta>) => void;
  onReset: () => void;
  /** The name the first output will get, so a typo shows before a render, not after. */
  previewName: string | null;
  otherCount: number;
}

const FIELDS: Array<{ key: keyof NamingMeta; label: string; placeholder: string }> = [
  { key: 'gameName', label: 'Game', placeholder: 'BubbleTea' },
  { key: 'version', label: 'Version', placeholder: 'v60' },
  { key: 'suffix', label: 'Hậu tố', placeholder: 'TTO' },
];

export function NamingFields({ config, onChange, onReset, previewName, otherCount }: NamingFieldsProps) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4" aria-label="Đặt tên">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-neutral-100">Đặt tên file</h2>
        {config.locked && (
          <button type="button" onClick={onReset} className="text-xs text-neutral-400 hover:text-white">
            Tự nhận từ tên file
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {FIELDS.map(({ key, label, placeholder }) => (
          <label key={key} className="block text-xs text-neutral-400">
            {label}
            <input
              type="text"
              value={config[key]}
              placeholder={placeholder}
              onChange={(event) => onChange({ [key]: event.target.value })}
              className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600"
            />
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-neutral-400">
        {config.locked
          ? 'Version tự tăng cho từng video trong lô.'
          : 'Đang tự nhận từ tên file. Gõ vào ô để cố định cho cả lô.'}
      </p>
      {previewName && (
        <p className="mt-1 text-xs text-neutral-300 break-all" data-testid="naming-preview">
          Ví dụ: <span className="font-mono">{previewName}</span>
          {otherCount > 0 && <span className="text-neutral-500"> (+{otherCount} video khác)</span>}
        </p>
      )}
    </section>
  );
}
