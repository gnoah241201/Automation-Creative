export type OverwriteChoice = 'overwrite' | 'skip' | 'bump' | 'cancel';

interface OverwriteDialogProps {
  /** Filenames that already sit in the output folder. */
  names: string[];
  /** The version the config would move to, or null when it has no number to count up. */
  bumpTo: string | null;
  onChoose: (choice: OverwriteChoice) => void;
}

const SHOWN = 8;

export function OverwriteDialog({ names, bumpTo, onChoose }: OverwriteDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-modal="true" aria-label="File đã tồn tại">
      <div className="w-full max-w-lg rounded-2xl border border-neutral-700 bg-neutral-900 p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-white">{names.length} file đã có trong thư mục</h2>
        <p className="mt-1 text-sm text-neutral-400">Thư mục xuất là sổ ghi những gì đã render. Chọn cách xử lý:</p>
        <ul className="mt-3 max-h-48 overflow-y-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs text-neutral-300" data-testid="overwrite-names">
          {names.slice(0, SHOWN).map((name) => <li key={name} className="truncate">{name}</li>)}
          {names.length > SHOWN && <li className="text-neutral-500">và {names.length - SHOWN} file khác</li>}
        </ul>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => onChoose('cancel')} className="rounded-lg border border-neutral-600 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800">
            Hủy
          </button>
          {bumpTo && (
            <button type="button" onClick={() => onChoose('bump')} className="rounded-lg border border-neutral-600 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800">
              Tăng version lên {bumpTo}
            </button>
          )}
          <button type="button" onClick={() => onChoose('skip')} className="rounded-lg border border-neutral-600 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800">
            Bỏ qua file trùng
          </button>
          <button type="button" onClick={() => onChoose('overwrite')} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500">
            Ghi đè
          </button>
        </div>
      </div>
    </div>
  );
}
