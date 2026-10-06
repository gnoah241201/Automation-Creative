import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Film, Image as ImageIcon, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { AspectRatio, BackgroundImageMode, ForegroundPosition, InputRatio } from '../core/contract';
import { RATIOS } from '../core/outputDerivation';
import { ResizeBatchSource } from '../core/librarySources';
import {
  getAnchorCenteredCropWindow,
  getOutputFrameDimensions,
  getPrecomposedHiddenFgAnchorPoint,
  getScaledCoverDimensions,
  PRECOMPOSED_BG_SCALE,
  shouldUsePrecomposedHiddenFgAnchor,
} from '../core/precomposedAnchor';
import { getBridge } from '../bridge/tauri';

/** What sits on top of the picture: the logo and the CTA button. Everything is optional. */
export interface PreviewOverlay {
  logoSrc?: string | null;
  logoSize: number;
  logoX: number;
  logoY: number;
  buttonText?: string;
  buttonSize: number;
  buttonX: number;
  buttonY: number;
}

export interface PreviewBoxProps {
  inputRatio: InputRatio;
  outputRatio: AspectRatio;
  /** Seconds after which the loop restarts. Undefined plays the whole clip. */
  duration?: number;
  /** URL the foreground video plays from. */
  fgSrc: string | null;
  /** URL of the background: the same clip for a self-blur, or the banner image. */
  bgSrc: string | null;
  bgType: 'video' | 'image';
  fgPosition: ForegroundPosition;
  backgroundImageMode: BackgroundImageMode;
  blurAmount: number;
  overlay?: PreviewOverlay;
}

const BUTTON_STYLE: CSSProperties = {
  color: '#FFFFFF',
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  textShadow: '0px 2px 4px rgba(0, 0, 0, 0.4)',
  background: 'linear-gradient(to bottom, #FFD700 0%, #FFB800 50%, #FF8A00 100%)',
  border: '1px solid #D2691E',
  boxShadow: '0px 6px 8px 0px rgba(0, 0, 0, 0.5), inset 2px 2px 4px rgba(255, 255, 255, 0.6)',
};

const transformOf = (x: number, y: number, size: number): CSSProperties => ({
  transform: `translate(${x}px, ${y}px) scale(${size / 100})`,
});

function Logo({ overlay }: { overlay: PreviewOverlay }) {
  if (!overlay.logoSrc) return null;
  return (
    <img
      src={overlay.logoSrc}
      alt="Logo"
      className="max-w-full max-h-full object-contain drop-shadow-lg"
      style={transformOf(overlay.logoX, overlay.logoY, overlay.logoSize)}
    />
  );
}

function CtaButton({ overlay, compact }: { overlay: PreviewOverlay; compact: boolean }) {
  if (!overlay.buttonText) return null;
  return (
    <div
      className="flex justify-center items-center w-full"
      style={transformOf(overlay.buttonX, overlay.buttonY, overlay.buttonSize)}
    >
      <div
        className={`font-bold rounded-full whitespace-nowrap tracking-wide relative overflow-hidden ${compact ? 'px-6 py-2 text-base' : 'px-8 py-3 text-lg'}`}
        style={BUTTON_STYLE}
      >
        {overlay.buttonText}
      </div>
    </div>
  );
}

/**
 * One side panel of a landscape frame holding a portrait clip: the logo above
 * the button when both exist, whichever one exists otherwise.
 */
function SidePanel({ overlay }: { overlay: PreviewOverlay }) {
  const hasLogo = Boolean(overlay.logoSrc);
  const hasButton = Boolean(overlay.buttonText);
  return (
    <div className="flex-1 flex flex-col items-center min-h-0 py-6 px-4 relative">
      {hasLogo && hasButton ? (
        <>
          <div className="flex items-center justify-center w-full overflow-hidden min-h-0" style={{ flex: 2 }}>
            <Logo overlay={overlay} />
          </div>
          <div className="h-4 shrink-0"></div>
          <div className="flex items-center justify-center w-full overflow-hidden min-h-0" style={{ flex: 1 }}>
            <CtaButton overlay={overlay} compact />
          </div>
        </>
      ) : hasLogo ? (
        <div className="flex items-center justify-center w-full h-full overflow-hidden min-h-0"><Logo overlay={overlay} /></div>
      ) : hasButton ? (
        <div className="flex items-center justify-center w-full h-full overflow-hidden min-h-0"><CtaButton overlay={overlay} compact /></div>
      ) : null}
    </div>
  );
}

const FRAME_CLASS: Record<AspectRatio, string> = {
  '9:16': 'aspect-[9/16] max-w-[280px]',
  '16:9': 'aspect-video max-w-[460px]',
  '4:5': 'aspect-[4/5] max-w-[320px]',
  '2:3': 'aspect-[2/3] max-w-[300px]',
  '1:1': 'aspect-square max-w-[340px]',
};

/**
 * The single preview. Lifted from the old per-ratio box, with the same layout
 * rules, so what is shown matches what the argv builder produces. It takes
 * URLs instead of File objects: the webview reads the picked file where it sits.
 */
export function PreviewBox({
  inputRatio, outputRatio, duration, fgSrc, bgSrc, bgType, fgPosition,
  backgroundImageMode, blurAmount, overlay,
}: PreviewBoxProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [bgImageNaturalSize, setBgImageNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const fgVideoRef = useRef<HTMLVideoElement>(null);

  const togglePlay = () => {
    if (isPlaying) {
      bgVideoRef.current?.pause();
      fgVideoRef.current?.pause();
      setIsPlaying(false);
    } else {
      bgVideoRef.current?.play().catch(() => { });
      fgVideoRef.current?.play().catch(() => { });
      setIsPlaying(true);
    }
  };

  useEffect(() => {
    const fg = fgVideoRef.current;
    const bg = bgVideoRef.current;
    if (!fg) return;

    const syncVideos = () => {
      if (bg && Math.abs(fg.currentTime - bg.currentTime) > 0.3) bg.currentTime = fg.currentTime;
    };
    const handleTimeUpdate = () => {
      if (duration && fg.currentTime >= duration) {
        fg.currentTime = 0;
        if (bg) bg.currentTime = 0;
      }
    };
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      fg.currentTime = 0;
      if (bg) bg.currentTime = 0;
    };

    fg.addEventListener('seeked', syncVideos);
    fg.addEventListener('play', handlePlay);
    fg.addEventListener('pause', handlePause);
    fg.addEventListener('timeupdate', handleTimeUpdate);
    fg.addEventListener('ended', handleEnded);
    return () => {
      fg.removeEventListener('seeked', syncVideos);
      fg.removeEventListener('play', handlePlay);
      fg.removeEventListener('pause', handlePause);
      fg.removeEventListener('timeupdate', handleTimeUpdate);
      fg.removeEventListener('ended', handleEnded);
    };
  }, [fgSrc, bgSrc, duration]);

  useEffect(() => { setIsPlaying(false); }, [fgSrc, bgSrc]);
  useEffect(() => { setBgImageNaturalSize(null); }, [bgSrc]);

  const showOverlays = (inputRatio === '16:9' && ['9:16', '4:5', '2:3', '1:1'].includes(outputRatio))
    || (inputRatio === '9:16' && outputRatio === '16:9');
  const hasOverlayContent = Boolean(overlay && (overlay.logoSrc || overlay.buttonText));

  const usesHiddenFgAnchorPreview = shouldUsePrecomposedHiddenFgAnchor({
    bgType, backgroundImageMode, inputRatio, fgPosition, outputRatio,
  });

  const targetedPreviewLayout = (() => {
    if (!usesHiddenFgAnchorPreview || !bgImageNaturalSize) return null;
    const anchor = getPrecomposedHiddenFgAnchorPoint(fgPosition);
    if (!anchor) return null;
    const frame = getOutputFrameDimensions(outputRatio);
    const scaled = getScaledCoverDimensions(bgImageNaturalSize, frame, PRECOMPOSED_BG_SCALE);
    const crop = getAnchorCenteredCropWindow(anchor, scaled, frame);
    return {
      widthPercent: (scaled.width / frame.width) * 100,
      heightPercent: (scaled.height / frame.height) * 100,
      leftPercent: -(crop.x / frame.width) * 100,
      topPercent: -(crop.y / frame.height) * 100,
    };
  })();

  const squareish = ['4:5', '2:3', '1:1'].includes(outputRatio);
  const backgroundImageClassName = targetedPreviewLayout
    ? 'absolute pointer-events-none max-w-none select-none'
    : `absolute inset-0 w-full h-full pointer-events-none ${squareish ? 'object-cover' : 'object-fill'}`;
  const backgroundImageStyle: CSSProperties | undefined = targetedPreviewLayout
    ? {
        width: `${targetedPreviewLayout.widthPercent}%`,
        height: `${targetedPreviewLayout.heightPercent}%`,
        left: `${targetedPreviewLayout.leftPercent}%`,
        top: `${targetedPreviewLayout.topPercent}%`,
      }
    : bgType === 'image' && backgroundImageMode === 'precomposed' && squareish
      ? { transform: `scale(${PRECOMPOSED_BG_SCALE})`, transformOrigin: 'center bottom' }
      : undefined;

  const portraitInLandscape = inputRatio === '9:16' && outputRatio === '16:9';

  return (
    <div className="flex flex-col items-center w-full">
      <div
        className={`relative w-full bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 transition-all duration-300 ${FRAME_CLASS[outputRatio]}`}
        data-testid="preview-frame"
      >
        {bgType === 'video' ? (
          bgSrc ? (
            <video
              ref={bgVideoRef}
              src={bgSrc}
              className="absolute inset-0 w-full h-full object-cover scale-110 opacity-70"
              style={{ filter: `blur(${blurAmount}px)` }}
              muted
              loop
              playsInline
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-700 bg-neutral-900/30">
              <ImageIcon className="w-8 h-8 mb-2 opacity-20" />
            </div>
          )
        ) : bgSrc ? (
          <img
            src={bgSrc}
            className={backgroundImageClassName}
            alt="Banner"
            style={backgroundImageStyle}
            onLoad={(event) => setBgImageNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-600 bg-neutral-900/30">
            <ImageIcon className="w-8 h-8 mb-2 opacity-30" />
            <span className="text-xs font-medium uppercase tracking-widest opacity-60">Chưa chọn banner</span>
          </div>
        )}

        {fgSrc ? (
          <video
            ref={fgVideoRef}
            src={fgSrc}
            className={`absolute z-10 drop-shadow-2xl cursor-pointer object-contain ${portraitInLandscape
              ? fgPosition === 'right'
                ? 'right-[40px] top-0 bottom-0 w-auto h-full aspect-[9/16]'
                : fgPosition === 'left'
                  ? 'left-[40px] top-0 bottom-0 w-auto h-full aspect-[9/16]'
                  : 'inset-0 mx-auto w-auto h-full aspect-[9/16]'
              : 'inset-0 w-full h-full'}`}
            muted={isMuted}
            loop
            playsInline
            onClick={togglePlay}
          />
        ) : (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-neutral-500 bg-neutral-950/80">
            <Film className="w-8 h-8 mb-2 opacity-50" />
            <span className="text-xs font-medium uppercase tracking-widest opacity-80">Chưa có video</span>
          </div>
        )}

        {showOverlays && overlay && hasOverlayContent && (
          <div className="absolute inset-0 z-30 flex flex-col pointer-events-none">
            {inputRatio === '16:9' ? (
              <>
                <div className="flex-1 flex items-center justify-center relative overflow-hidden p-4">
                  <Logo overlay={overlay} />
                </div>
                <div className="w-full aspect-video shrink-0"></div>
                <div className="flex-1 flex items-center justify-center relative overflow-hidden p-4">
                  <CtaButton overlay={overlay} compact={false} />
                </div>
              </>
            ) : (
              <div className="absolute inset-0 z-30 flex pointer-events-none">
                {fgPosition === 'right' ? (
                  <>
                    <SidePanel overlay={overlay} />
                    <div className="h-full aspect-[9/16] shrink-0 mr-[40px]"></div>
                  </>
                ) : fgPosition === 'left' ? (
                  <>
                    <div className="h-full aspect-[9/16] shrink-0 ml-[40px]"></div>
                    <SidePanel overlay={overlay} />
                  </>
                ) : (
                  <>
                    <div className="flex-1 flex items-center justify-center py-6 px-4 relative">
                      <div className="w-full h-full flex items-center justify-center overflow-hidden"><Logo overlay={overlay} /></div>
                    </div>
                    <div className="h-full aspect-[9/16] shrink-0"></div>
                    <div className="flex-1 flex items-center justify-center py-6 px-4 relative">
                      <div className="w-full h-full flex items-center justify-center overflow-hidden">
                        <CtaButton overlay={overlay} compact />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {fgSrc && !isPlaying && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none bg-black/20">
            <div className="w-14 h-14 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white">
              <Play className="w-7 h-7 fill-current ml-1" />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!fgSrc}
          aria-label={isPlaying ? 'Tạm dừng' : 'Phát'}
          className="w-9 h-9 flex items-center justify-center bg-white text-black rounded-full hover:bg-neutral-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
        </button>
        <button
          type="button"
          onClick={() => setIsMuted((value) => !value)}
          aria-label={isMuted ? 'Bật tiếng' : 'Tắt tiếng'}
          className="w-9 h-9 flex items-center justify-center rounded-full border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

interface PreviewPaneProps {
  sources: ResizeBatchSource[];
  /** The previewed source's path. Falls back to the first source. */
  sourcePath: string | null;
  onSourcePath: (path: string) => void;
  tickedRatios: ReadonlySet<AspectRatio>;
  ratio: AspectRatio;
  onRatio: (ratio: AspectRatio) => void;
  background: { kind: 'self' | 'banner'; bannerPath: string | null; bannerMode: BackgroundImageMode };
  fgPosition: ForegroundPosition;
  overlay?: Omit<PreviewOverlay, 'logoSrc'> & { logoPath?: string | null };
}

/** `fileUrl` throws outside a Tauri window; a preview that cannot load is empty, not a crash. */
const urlFor = (path: string | null | undefined): string | null => {
  if (!path) return null;
  try { return getBridge().fileUrl(path); } catch { return null; }
};

/** The preview with its two pickers: which video, which ratio. */
export function PreviewPane({
  sources, sourcePath, onSourcePath, tickedRatios, ratio, onRatio, background, fgPosition, overlay,
}: PreviewPaneProps) {
  const source = sources.find((candidate) => candidate.path === sourcePath) ?? sources[0];
  const fgSrc = useMemo(() => urlFor(source?.path), [source?.path]);
  const bannerSrc = useMemo(() => urlFor(background.bannerPath), [background.bannerPath]);
  const logoSrc = useMemo(() => urlFor(overlay?.logoPath), [overlay?.logoPath]);

  const isBanner = background.kind === 'banner';

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4" aria-label="Xem trước">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="text-xs text-neutral-400" htmlFor="preview-source">Video</label>
        <select
          id="preview-source"
          value={source?.path ?? ''}
          onChange={(event) => onSourcePath(event.target.value)}
          disabled={sources.length === 0}
          className="min-w-0 flex-1 truncate rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 disabled:opacity-50"
        >
          {sources.length === 0 && <option value="">Chưa có video</option>}
          {sources.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>{candidate.filename}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mb-4" role="group" aria-label="Tỉ lệ xem trước">
        <span className="text-xs text-neutral-400 mr-1">Tỉ lệ</span>
        {RATIOS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={candidate === ratio}
            onClick={() => onRatio(candidate)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${candidate === ratio
              ? 'bg-white text-black border-white'
              : tickedRatios.has(candidate)
                ? 'border-neutral-500 text-neutral-100 hover:bg-neutral-800'
                : 'border-neutral-800 text-neutral-500 hover:bg-neutral-800'}`}
          >
            {candidate}
          </button>
        ))}
      </div>
      <PreviewBox
        inputRatio={source?.inputRatio ?? '9:16'}
        outputRatio={ratio}
        fgSrc={fgSrc}
        bgSrc={isBanner ? bannerSrc : fgSrc}
        bgType={isBanner ? 'image' : 'video'}
        fgPosition={fgPosition}
        backgroundImageMode={background.bannerMode}
        blurAmount={24}
        overlay={overlay ? { ...overlay, logoSrc } : undefined}
      />
    </section>
  );
}
