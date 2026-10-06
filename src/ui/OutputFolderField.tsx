import { FolderOpen } from 'lucide-react';

interface OutputFolderFieldProps {
  value: string | null;
  disabled?: boolean;
  onPick: () => void;
}

export function OutputFolderField({ value, disabled, onPick }: OutputFolderFieldProps) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4" aria-label="Thư mục lưu">
      <h2 className="text-sm font-semibold text-neutral-100 mb-2">Thư mục lưu</h2>
      <div className="flex items-center gap-2">
        <div
          className={`min-w-0 flex-1 truncate rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm ${value ? 'text-neutral-100' : 'text-neutral-500'}`}
          title={value ?? undefined}
          data-testid="output-folder"
        >
          {value ?? 'Chưa chọn thư mục'}
        </div>
        <button
          type="button"
          onClick={onPick}
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-600 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800 disabled:opacity-50"
        >
          <FolderOpen className="h-4 w-4" />
          {value ? 'Đổi' : 'Chọn'}
        </button>
      </div>
    </section>
  );
}
