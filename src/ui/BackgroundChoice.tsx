import { BackgroundImageMode } from '../core/contract';
import { basename } from '../core/batchSources';

interface BackgroundChoiceProps {
  source: 'self' | 'banner';
  bannerPath: string | null;
  bannerMode: BackgroundImageMode;
  onSelf: () => void;
  onBanner: () => void;
  onChangeBanner: () => void;
  onBannerMode: (mode: BackgroundImageMode) => void;
}

const option = (active: boolean) => `flex-1 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${active
  ? 'border-blue-400 bg-blue-500/10 text-white'
  : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'}`;

export function BackgroundChoice({
  source, bannerPath, bannerMode, onSelf, onBanner, onChangeBanner, onBannerMode,
}: BackgroundChoiceProps) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4" aria-label="Nền">
      <h2 className="text-sm font-semibold text-neutral-100 mb-3">Nền</h2>
      <div className="flex gap-2">
        <button type="button" aria-pressed={source === 'self'} onClick={onSelf} className={option(source === 'self')}>
          <span className="block font-medium">Làm mờ chính video</span>
          <span className="block text-xs text-neutral-400">Không cần thêm file</span>
        </button>
        <button type="button" aria-pressed={source === 'banner'} onClick={onBanner} className={option(source === 'banner')}>
          <span className="block font-medium">Ảnh banner</span>
          <span className="block text-xs text-neutral-400 truncate">
            {bannerPath ? basename(bannerPath) : 'Chọn ảnh dùng chung cho cả lô'}
          </span>
        </button>
      </div>
      {source === 'banner' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
          <label htmlFor="banner-mode">Kiểu banner</label>
          <select
            id="banner-mode"
            value={bannerMode}
            onChange={(event) => onBannerMode(event.target.value as BackgroundImageMode)}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
          >
            <option value="clean">Ảnh nền sạch</option>
            <option value="precomposed">Banner dựng sẵn</option>
          </select>
          {bannerPath && (
            <button type="button" onClick={onChangeBanner} className="ml-auto text-neutral-300 hover:text-white">Đổi ảnh</button>
          )}
        </div>
      )}
      {source === 'banner' && !bannerPath && (
        <p className="mt-2 text-xs text-amber-300">Chưa chọn ảnh banner, nên chưa render được.</p>
      )}
    </section>
  );
}
