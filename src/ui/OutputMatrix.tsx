import { useMemo } from 'react';
import { AspectRatio } from '../core/contract';
import { deriveSourceOutputs } from '../core/batchOutputs';
import { ResizeBatchSource } from '../core/librarySources';
import { LengthMode, OutputConfig, RATIOS } from '../core/outputDerivation';

interface OutputMatrixProps {
  catalog: OutputConfig[];
  sources: ResizeBatchSource[];
  selected: ReadonlySet<string>;
  mode: LengthMode;
  onToggle: (id: string) => void;
  onToggleMany: (ids: string[], on: boolean) => void;
}

/** The id a ratio and a length share in the catalog: the bare ratio is the full-length output. */
const cellId = (ratio: AspectRatio, seconds: number | undefined) => (seconds === undefined ? ratio : `${ratio}-${seconds}s`);

const MODE_HINT: Record<LengthMode, string> = {
  speed: 'Tua nhanh: cả video được tua cho vừa 15s / 30s, không mất đoạn cuối.',
  cut: 'Cắt: giữ N giây đầu của bản full-length, không encode lại.',
};

/**
 * Ratios down the side, lengths across the top. Only lengths at least one
 * source can fill get a column, because the catalog is the union of what each
 * source offers; a cell a given source cannot fill is simply not planned for it.
 */
export function OutputMatrix({ catalog, sources, selected, mode, onToggle, onToggleMany }: OutputMatrixProps) {
  const present = useMemo(() => new Set(catalog.map((output) => output.id)), [catalog]);

  // How many sources can fill each output, so a column that only suits some of
  // the batch says so instead of leaving a tick that quietly does less.
  const supportCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of sources) {
      for (const output of deriveSourceOutputs(source, mode)) {
        counts.set(output.id, (counts.get(output.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [sources, mode]);

  const columns = useMemo(() => {
    const seconds = new Set<number>();
    let hasFull = false;
    for (const output of catalog) {
      if (output.duration === undefined) hasFull = true;
      else seconds.add(output.duration);
    }
    return [...(hasFull ? [undefined] : []), ...[...seconds].sort((a, b) => a - b)] as Array<number | undefined>;
  }, [catalog]);

  if (catalog.length === 0) {
    return (
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4" aria-label="Bảng xuất ra">
        <h2 className="text-sm font-semibold text-neutral-100">Xuất ra</h2>
        <p className="mt-2 text-sm text-neutral-500">Chọn video để thấy các tỉ lệ và độ dài có thể xuất.</p>
      </section>
    );
  }

  const idsInColumn = (seconds: number | undefined) => RATIOS.map((ratio) => cellId(ratio, seconds)).filter((id) => present.has(id));
  const idsInRow = (ratio: AspectRatio) => columns.map((seconds) => cellId(ratio, seconds)).filter((id) => present.has(id));
  const allTicked = (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id));

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4" aria-label="Bảng xuất ra">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-neutral-100">Xuất ra</h2>
        <p className="text-xs text-neutral-500">{MODE_HINT[mode]}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="output-matrix">
          <thead>
            <tr className="text-xs text-neutral-400">
              <th className="text-left font-normal pb-2 pr-3">Tỉ lệ</th>
              {columns.map((seconds) => {
                const ids = idsInColumn(seconds);
                const count = supportCount.get(cellId(RATIOS[0], seconds)) ?? 0;
                return (
                  <th key={seconds ?? 'full'} className="pb-2 px-2 font-normal text-center" data-testid="matrix-column">
                    <label className="inline-flex flex-col items-center gap-1 cursor-pointer">
                      <span className="font-medium text-neutral-200">{seconds === undefined ? 'Full' : `${seconds}s`}</span>
                      <input
                        type="checkbox"
                        aria-label={`Chọn cả cột ${seconds === undefined ? 'full-length' : `${seconds}s`}`}
                        checked={allTicked(ids)}
                        onChange={(event) => onToggleMany(ids, event.target.checked)}
                      />
                      {count < sources.length && (
                        <span className="text-[10px] text-amber-300" title="Video ngắn hơn mốc này sẽ không có bản này">
                          {count}/{sources.length} video
                        </span>
                      )}
                    </label>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {RATIOS.map((ratio) => {
              const ids = idsInRow(ratio);
              return (
                <tr key={ratio} className="border-t border-neutral-800/70">
                  <th className="text-left font-medium py-2 pr-3 text-neutral-200">
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        aria-label={`Chọn cả hàng ${ratio}`}
                        checked={allTicked(ids)}
                        onChange={(event) => onToggleMany(ids, event.target.checked)}
                      />
                      {ratio}
                    </label>
                  </th>
                  {columns.map((seconds) => {
                    const id = cellId(ratio, seconds);
                    return (
                      <td key={id} className="py-2 px-2 text-center">
                        {present.has(id) ? (
                          <input
                            type="checkbox"
                            aria-label={`Xuất ${ratio}${seconds === undefined ? ' full-length' : ` ${seconds}s`}`}
                            data-output-id={id}
                            checked={selected.has(id)}
                            onChange={() => onToggle(id)}
                          />
                        ) : (
                          <span className="text-neutral-700">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
