import React, { CSSProperties, useState, useRef, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Upload, Play, Pause, Volume2, VolumeX, Image as ImageIcon, Film, Type, Move, Download, X, RefreshCw, RotateCcw } from 'lucide-react';
import { NamingMeta, parseVideoNamingMeta, buildOutputFilename } from './naming';
import { RenderSpec } from '../shared/render-contract';
import { buildRenderSpec } from './render/renderSpec';
import { createOverlayPng } from './render/overlay';
import { cancelRenderJob, createRenderJob, createTrimJob, createUploadSession, downloadRenderJob, getAuthSession, getRenderJob, login as loginRequest, loginWithGoogle, logout as logoutRequest } from './render/api';
import { deriveOutputs, OutputConfig } from './render/outputDerivation';
import { getJobDisplayName } from './render/jobDisplay';
import {
  DEFAULT_LOGO_SIZE,
  DEFAULT_LOGO_X,
  DEFAULT_LOGO_Y,
  DEFAULT_BUTTON_TYPE,
  DEFAULT_BUTTON_TEXT,
  DEFAULT_BUTTON_SIZE,
  DEFAULT_BUTTON_X,
  DEFAULT_BUTTON_Y,
} from './render/overlayDefaults';
import { createDefaultButtonState, createDefaultLogoState } from './render/resetState';
import { useJobPolling } from './render/useJobPolling';
import { AppShell, AppTab } from './app/AppShell';
import { HookComposerPage } from './composer/HookComposerPage';
import { LocalLibraryPage } from './library/LocalLibraryPage';
import { ResizeBatchPanel } from './render/ResizeBatchPanel';
import { ResizeBatchSource } from './render/librarySources';
import { submitResizeBatch } from './render/submitResizeBatch';
import {
  getAnchorCenteredCropWindow,
  getOutputFrameDimensions,
  getPrecomposedHiddenFgAnchorPoint,
  getScaledCoverDimensions,
  PRECOMPOSED_BG_SCALE,
  shouldUsePrecomposedHiddenFgAnchor,
} from '../shared/precomposedAnchor';

type RenderJob = {
  id: string;
  serverJobId?: string;
  outputId: string;
  label: string;
  filename: string;
  spec: RenderSpec;
  status: 'submitting' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelling' | 'cancelled';
  progress: number;
  progressMode?: 'determinate' | 'indeterminate';
  error?: string;
  lastPollError?: string;
  lastActionError?: string;
  retryInputs?: {
    foregroundFile: File;
    backgroundType: 'video' | 'image';
    backgroundVideoFile?: File | null;
    backgroundImageFile?: File | null;
    logoFile?: File | null;
    logoUrl?: string | null;
    buttonImageFile?: File | null;
    buttonImageUrl?: string | null;
  };
  downloadUrl?: string;
};

function PreviewBox({
  inputRatio,
  outputRatio,
  duration,
  label,
  fgVideo,
  fgPosition,
  bgType,
  bgVideo,
  bgImage,
  backgroundImageMode,
  blurAmount,
  logo, logoX, logoY, logoSize,
  buttonType, buttonText, buttonImage, buttonX, buttonY, buttonSize,
  isMuted
}: any) {
  const [isPlaying, setIsPlaying] = useState(false);
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
    if (!fg || !bg) return;

    const syncVideos = () => {
      if (Math.abs(fg.currentTime - bg.currentTime) > 0.3) {
        bg.currentTime = fg.currentTime;
      }
    };

    const handleTimeUpdate = () => {
      if (duration && fg.currentTime >= duration) {
        fg.currentTime = 0;
        bg.currentTime = 0;
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      fg.currentTime = 0;
      bg.currentTime = 0;
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
  }, [fgVideo, bgVideo, duration]);

  useEffect(() => {
    setIsPlaying(false);
  }, [fgVideo, bgVideo]);

  useEffect(() => {
    setBgImageNaturalSize(null);
  }, [bgImage]);

  const showOverlays = (inputRatio === '16:9' && ['9:16', '4:5', '1:1'].includes(outputRatio)) ||
    (inputRatio === '9:16' && outputRatio === '16:9');

  const usesHiddenFgAnchorPreview = shouldUsePrecomposedHiddenFgAnchor({
    bgType,
    backgroundImageMode,
    inputRatio,
    fgPosition,
    outputRatio,
  });

  const targetedPreviewLayout = (() => {
    if (!usesHiddenFgAnchorPreview || !bgImageNaturalSize) {
      return null;
    }

    const anchor = getPrecomposedHiddenFgAnchorPoint(fgPosition);
    if (!anchor) {
      return null;
    }

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

  const backgroundImageClassName = targetedPreviewLayout
    ? 'absolute pointer-events-none max-w-none select-none'
    : `absolute inset-0 w-full h-full pointer-events-none ${['4:5', '1:1'].includes(outputRatio) ? 'object-cover' : 'object-fill'}`;

  const backgroundImageStyle: CSSProperties | undefined = targetedPreviewLayout
    ? {
        width: `${targetedPreviewLayout.widthPercent}%`,
        height: `${targetedPreviewLayout.heightPercent}%`,
        left: `${targetedPreviewLayout.leftPercent}%`,
        top: `${targetedPreviewLayout.topPercent}%`,
      }
    : bgType === 'image' && backgroundImageMode === 'precomposed' && ['4:5', '1:1'].includes(outputRatio)
      ? {
          transform: `scale(${PRECOMPOSED_BG_SCALE})`,
          transformOrigin: 'center bottom',
        }
      : undefined;

  return (
    <div className="flex flex-col items-center w-full mb-12 pb-8 border-b border-neutral-800/50 last:border-0">
      <div className="flex items-center justify-between w-full max-w-[640px] mb-4 px-4">
        <h3 className="text-lg font-semibold text-white">{label}</h3>
        <button
          onClick={togglePlay}
          className="w-10 h-10 flex items-center justify-center bg-white text-black rounded-full hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
          disabled={!fgVideo}
        >
          {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-1" />}
        </button>
      </div>

      <div
        className={`relative w-full bg-black rounded-3xl overflow-hidden shadow-2xl ring-1 ring-white/10 group transition-all duration-500 ease-in-out ${outputRatio === '9:16' ? 'aspect-[9/16] max-w-[360px]' :
          outputRatio === '16:9' ? 'aspect-video max-w-[640px]' :
            outputRatio === '4:5' ? 'aspect-[4/5] max-w-[400px]' :
              'aspect-square max-w-[450px]'
          }`}
      >
        {/* Background Video or Image */}
        {bgType === 'video' ? (
          bgVideo ? (
            <video
              ref={bgVideoRef}
              src={bgVideo}
              className="absolute inset-0 w-full h-full object-cover scale-110 opacity-70 transition-all duration-300"
              style={{ filter: `blur(${blurAmount}px)` }}
              muted
              loop
              playsInline
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-700 bg-neutral-900/30">
              <ImageIcon className="w-8 h-8 mb-2 opacity-20" />
              <span className="text-xs font-medium uppercase tracking-widest opacity-50">Background Video</span>
            </div>
          )
        ) : (
          bgImage ? (
            <img
              src={bgImage}
              className={backgroundImageClassName}
              alt="Banner Background"
              style={backgroundImageStyle}
              onLoad={(event) => {
                setBgImageNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-700 bg-neutral-900/30">
              <ImageIcon className="w-8 h-8 mb-2 opacity-20" />
              <span className="text-xs font-medium uppercase tracking-widest opacity-50">Banner Image</span>
            </div>
          )
        )}

        {/* Foreground Video */}
        {fgVideo ? (
          <video
            ref={fgVideoRef}
            src={fgVideo}
            className={`absolute z-10 drop-shadow-2xl cursor-pointer object-contain transition-all duration-500 ${inputRatio === '9:16' && outputRatio === '16:9'
              ? fgPosition === 'right'
                ? 'right-[40px] top-0 bottom-0 w-auto h-full aspect-[9/16]'
                : fgPosition === 'left'
                  ? 'left-[40px] top-0 bottom-0 w-auto h-full aspect-[9/16]'
                  : 'inset-0 mx-auto w-auto h-full aspect-[9/16]'
              : 'inset-0 w-full h-full'
              }`}
            muted={isMuted}
            loop
            playsInline
            onClick={togglePlay}
          />
        ) : (
          <div className={`absolute flex flex-col items-center justify-center text-neutral-500 z-10 bg-neutral-950/80 backdrop-blur-sm transition-all duration-500 ${inputRatio === '9:16' && outputRatio === '16:9'
            ? fgPosition === 'right'
              ? 'right-[40px] top-0 bottom-0 w-auto h-full aspect-[9/16] border-x border-neutral-800/50'
              : fgPosition === 'left'
                ? 'left-[40px] top-0 bottom-0 w-auto h-full aspect-[9/16] border-x border-neutral-800/50'
                : 'inset-y-0 mx-auto h-full aspect-[9/16] w-fit border-x border-neutral-800/50'
            : inputRatio === '16:9'
              ? 'inset-x-0 border-y border-neutral-800/50 my-auto w-full aspect-video h-fit'
              : 'inset-y-0 border-x border-neutral-800/50 mx-auto h-full aspect-[9/16] w-fit'
            }`}>
            <Film className="w-8 h-8 mb-2 opacity-50" />
            <span className="text-xs font-medium uppercase tracking-widest opacity-80">Foreground</span>
          </div>
        )}

        {/* Overlays Container */}
        {showOverlays && (
          <div className="absolute inset-0 z-30 flex flex-col pointer-events-none">
            {inputRatio === '16:9' ? (
              <>
                {/* Top Empty Space (Logo) */}
                <div className="flex-1 flex items-center justify-center relative overflow-hidden p-4">
                  {logo && (
                    <img
                      src={logo}
                      alt="Logo"
                      className="max-w-full max-h-full object-contain drop-shadow-lg"
                      style={{
                        transform: `translate(${logoX}px, ${logoY}px) scale(${logoSize / 100})`
                      }}
                    />
                  )}
                </div>

                {/* Middle Space (Foreground Video Area - exactly 16:9) */}
                <div className="w-full aspect-video shrink-0"></div>

                {/* Bottom Empty Space (Button) */}
                <div className="flex-1 flex items-center justify-center relative overflow-hidden p-4">
                  {((buttonType === 'text' && buttonText) || (buttonType === 'image' && buttonImage)) && (
                    <div
                      className="flex justify-center items-center w-full"
                      style={{
                        transform: `translate(${buttonX}px, ${buttonY}px) scale(${buttonSize / 100})`
                      }}
                    >
                      {buttonType === 'text' ? (
                        <div
                          className="px-8 py-3 font-bold rounded-full whitespace-nowrap text-lg tracking-wide relative overflow-hidden"
                          style={{
                            color: '#FFFFFF',
                            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                            textShadow: '0px 2px 4px rgba(0, 0, 0, 0.4)',
                            background: 'linear-gradient(to bottom, #FFD700 0%, #FFB800 50%, #FF8A00 100%)',
                            border: '1px solid #D2691E',
                            boxShadow: '0px 6px 8px 0px rgba(0, 0, 0, 0.5), inset 2px 2px 4px rgba(255, 255, 255, 0.6)',
                          }}
                        >
                          {buttonText}
                        </div>
                      ) : (
                        <img
                          src={buttonImage!}
                          alt="Custom Button"
                          className="max-w-full max-h-full object-contain drop-shadow-xl"
                        />
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="absolute inset-0 z-30 flex pointer-events-none transition-all duration-500">
                {fgPosition === 'right' ? (() => {
                  const hasLogo = !!logo;
                  const hasButton = (buttonType === 'text' && buttonText) || (buttonType === 'image' && buttonImage);
                  return (
                  <>
                    <div className="flex-1 flex flex-col items-center min-h-0 py-6 px-4 relative">
                      {hasLogo && hasButton ? (
                        <>
                          <div className="flex items-center justify-center w-full overflow-hidden min-h-0" style={{ flex: 2 }}>
                            <img src={logo} alt="Logo" className="max-w-full max-h-full object-contain drop-shadow-lg" style={{ transform: `translate(${logoX}px, ${logoY}px) scale(${logoSize / 100})` }} />
                          </div>
                          <div className="h-4 shrink-0"></div>
                          <div className="flex items-center justify-center w-full overflow-hidden min-h-0" style={{ flex: 1 }}>
                            <div className="flex justify-center items-center w-full" style={{ transform: `translate(${buttonX}px, ${buttonY}px) scale(${buttonSize / 100})` }}>
                              {buttonType === 'text' ? (
                                <div className="px-6 py-2 font-bold rounded-full whitespace-nowrap text-base tracking-wide relative overflow-hidden text-white" style={{ fontFamily: 'system-ui, sans-serif', textShadow: '0px 2px 4px rgba(0,0,0,0.4)', background: 'linear-gradient(to bottom, #FFD700 0%, #FFB800 50%, #FF8A00 100%)', border: '1px solid #D2691E', boxShadow: '0px 6px 8px 0px rgba(0,0,0,0.5), inset 2px 2px 4px rgba(255,255,255,0.6)' }}>
                                  {buttonText}
                                </div>
                              ) : (
                                <img src={buttonImage!} alt="Custom Button" className="max-w-full max-h-full object-contain drop-shadow-xl" />
                              )}
                            </div>
                          </div>
                        </>
                      ) : hasLogo ? (
                        <div className="flex items-center justify-center w-full h-full overflow-hidden min-h-0">
                          <img src={logo} alt="Logo" className="max-w-full max-h-full object-contain drop-shadow-lg" style={{ transform: `translate(${logoX}px, ${logoY}px) scale(${logoSize / 100})` }} />
                        </div>
                      ) : hasButton ? (
                        <div className="flex items-center justify-center w-full h-full overflow-hidden min-h-0">
                          <div className="flex justify-center items-center w-full" style={{ transform: `translate(${buttonX}px, ${buttonY}px) scale(${buttonSize / 100})` }}>
                            {buttonType === 'text' ? (
                              <div className="px-6 py-2 font-bold rounded-full whitespace-nowrap text-base tracking-wide relative overflow-hidden text-white" style={{ fontFamily: 'system-ui, sans-serif', textShadow: '0px 2px 4px rgba(0,0,0,0.4)', background: 'linear-gradient(to bottom, #FFD700 0%, #FFB800 50%, #FF8A00 100%)', border: '1px solid #D2691E', boxShadow: '0px 6px 8px 0px rgba(0,0,0,0.5), inset 2px 2px 4px rgba(255,255,255,0.6)' }}>
                                {buttonText}
                              </div>
                            ) : (
                              <img src={buttonImage!} alt="Custom Button" className="max-w-full max-h-full object-contain drop-shadow-xl" />
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="h-full aspect-[9/16] shrink-0 mr-[40px]"></div>
                  </>
                  );
                })()
                : fgPosition === 'left' ? (() => {
                  const hasLogo = !!logo;
                  const hasButton = (buttonType === 'text' && buttonText) || (buttonType === 'image' && buttonImage);
                  return (
                  <>
                    <div className="h-full aspect-[9/16] shrink-0 ml-[40px]"></div>
                    <div className="flex-1 flex flex-col items-center min-h-0 py-6 px-4 relative">
                      {hasLogo && hasButton ? (
                        <>
                          <div className="flex items-center justify-center w-full overflow-hidden min-h-0" style={{ flex: 2 }}>
                            <img src={logo} alt="Logo" className="max-w-full max-h-full object-contain drop-shadow-lg" style={{ transform: `translate(${logoX}px, ${logoY}px) scale(${logoSize / 100})` }} />
                          </div>
                          <div className="h-4 shrink-0"></div>
                          <div className="flex items-center justify-center w-full overflow-hidden min-h-0" style={{ flex: 1 }}>
                            <div className="flex justify-center items-center w-full" style={{ transform: `translate(${buttonX}px, ${buttonY}px) scale(${buttonSize / 100})` }}>
                              {buttonType === 'text' ? (
                                <div className="px-6 py-2 font-bold rounded-full whitespace-nowrap text-base tracking-wide relative overflow-hidden text-white" style={{ fontFamily: 'system-ui, sans-serif', textShadow: '0px 2px 4px rgba(0,0,0,0.4)', background: 'linear-gradient(to bottom, #FFD700 0%, #FFB800 50%, #FF8A00 100%)', border: '1px solid #D2691E', boxShadow: '0px 6px 8px 0px rgba(0,0,0,0.5), inset 2px 2px 4px rgba(255,255,255,0.6)' }}>
                                  {buttonText}
                                </div>
                              ) : (
                                <img src={buttonImage!} alt="Custom Button" className="max-w-full max-h-full object-contain drop-shadow-xl" />
                              )}
                            </div>
                          </div>
                        </>
                      ) : hasLogo ? (
                        <div className="flex items-center justify-center w-full h-full overflow-hidden min-h-0">
                          <img src={logo} alt="Logo" className="max-w-full max-h-full object-contain drop-shadow-lg" style={{ transform: `translate(${logoX}px, ${logoY}px) scale(${logoSize / 100})` }} />
                        </div>
                      ) : hasButton ? (
                        <div className="flex items-center justify-center w-full h-full overflow-hidden min-h-0">
                          <div className="flex justify-center items-center w-full" style={{ transform: `translate(${buttonX}px, ${buttonY}px) scale(${buttonSize / 100})` }}>
                            {buttonType === 'text' ? (
                              <div className="px-6 py-2 font-bold rounded-full whitespace-nowrap text-base tracking-wide relative overflow-hidden text-white" style={{ fontFamily: 'system-ui, sans-serif', textShadow: '0px 2px 4px rgba(0,0,0,0.4)', background: 'linear-gradient(to bottom, #FFD700 0%, #FFB800 50%, #FF8A00 100%)', border: '1px solid #D2691E', boxShadow: '0px 6px 8px 0px rgba(0,0,0,0.5), inset 2px 2px 4px rgba(255,255,255,0.6)' }}>
                                {buttonText}
                              </div>
                            ) : (
                              <img src={buttonImage!} alt="Custom Button" className="max-w-full max-h-full object-contain drop-shadow-xl" />
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </>
                  );
                })()
                : (
                  <>
                    <div className="flex-1 flex items-center justify-center py-6 px-4 relative">
                      <div className="w-full h-full flex items-center justify-center overflow-hidden">
                        {logo && (
                          <img
                            src={logo}
                            alt="Logo"
                            className="max-w-full max-h-full object-contain drop-shadow-lg"
                            style={{ transform: `translate(${logoX}px, ${logoY}px) scale(${logoSize / 100})` }}
                          />
                        )}
                      </div>
                    </div>
                    <div className="h-full aspect-[9/16] shrink-0"></div>
                    <div className="flex-1 flex items-center justify-center py-6 px-4 relative">
                      <div className="w-full h-full flex items-center justify-center overflow-hidden">
                        {((buttonType === 'text' && buttonText) || (buttonType === 'image' && buttonImage)) && (
                          <div className="flex justify-center items-center w-full h-full" style={{ transform: `translate(${buttonX}px, ${buttonY}px) scale(${buttonSize / 100})` }}>
                            {buttonType === 'text' ? (
                              <div className="px-6 py-2 font-bold rounded-full whitespace-nowrap text-base tracking-wide relative overflow-hidden text-white" style={{ fontFamily: 'system-ui, sans-serif', textShadow: '0px 2px 4px rgba(0,0,0,0.4)', background: 'linear-gradient(to bottom, #FFD700 0%, #FFB800 50%, #FF8A00 100%)', border: '1px solid #D2691E', boxShadow: '0px 6px 8px 0px rgba(0,0,0,0.5), inset 2px 2px 4px rgba(255,255,255,0.6)' }}>
                                {buttonText}
                              </div>
                            ) : (
                              <img src={buttonImage!} alt="Custom Button" className="max-w-full max-h-full object-contain drop-shadow-xl" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Playback Overlay */}
        {fgVideo && !isPlaying && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none bg-black/20">
            <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white">
              <Play className="w-8 h-8 fill-current ml-1" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type DropZone = 'foreground' | 'bgVideo' | 'bgImage' | 'logo' | 'buttonImage' | null;
type DropZoneKey = Exclude<DropZone, null>;

export default function App() {
  const googleClientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined;
  const googleWorkspaceDomain = import.meta.env.VITE_GOOGLE_WORKSPACE_DOMAIN as string | undefined;

  const [authLoading, setAuthLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authUsername, setAuthUsername] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('resize');
  const [resizeBatchSources, setResizeBatchSources] = useState<ResizeBatchSource[]>([]);
  const [isBatchSubmitting, setIsBatchSubmitting] = useState(false);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  const [bgType, setBgType] = useState<'video' | 'image'>('video');
  const [bgVideo, setBgVideo] = useState<string | null>(null);
  const [bgVideoFile, setBgVideoFile] = useState<File | null>(null);
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [bgImageFile, setBgImageFile] = useState<File | null>(null);
  const [backgroundImageMode, setBackgroundImageMode] = useState<'clean' | 'precomposed'>('clean');
  const [fgVideo, setFgVideo] = useState<string | null>(null);
  const [fgFile, setFgFile] = useState<File | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [blurAmount, setBlurAmount] = useState(24); // px

  const [logo, setLogo] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoSize, setLogoSize] = useState(DEFAULT_LOGO_SIZE);
  const [logoX, setLogoX] = useState(DEFAULT_LOGO_X);
  const [logoY, setLogoY] = useState(DEFAULT_LOGO_Y);
  const [buttonType, setButtonType] = useState<'text' | 'image'>(DEFAULT_BUTTON_TYPE);
  const [buttonText, setButtonText] = useState(DEFAULT_BUTTON_TEXT);
  const [buttonImage, setButtonImage] = useState<string | null>(null);
  const [buttonImageFile, setButtonImageFile] = useState<File | null>(null);
  const [buttonSize, setButtonSize] = useState(DEFAULT_BUTTON_SIZE);
  const [buttonX, setButtonX] = useState(DEFAULT_BUTTON_X);
  const [buttonY, setButtonY] = useState(DEFAULT_BUTTON_Y);
  const [inputRatio, setInputRatio] = useState<'16:9' | '9:16'>('16:9');
  const [fgPosition, setFgPosition] = useState<'left' | 'center' | 'right'>('right');
  // Naming metadata
  const [gameName, setGameName] = useState('');
  const [version, setVersion] = useState('');
  const [suffix, setSuffix] = useState('');
  const [fgDuration, setFgDuration] = useState<number | undefined>(undefined);
  const [autoDetectedFields, setAutoDetectedFields] = useState<Set<string>>(new Set());

  // Drag-and-drop state
  const [activeDropZone, setActiveDropZone] = useState<DropZone>(null);
  const dragDepthRef = useRef<Record<DropZoneKey, number>>({
    foreground: 0,
    bgVideo: 0,
    bgImage: 0,
    logo: 0,
    buttonImage: 0,
  });


  // Job Queue State
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Modal for Download Selection
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [selectedDownloads, setSelectedDownloads] = useState<string[]>([]);
  const [customBitrate, setCustomBitrate] = useState('');

  useEffect(() => {
    let cancelled = false;

    const loadSession = async () => {
      try {
        const session = await getAuthSession();
        if (cancelled) return;
        setIsAuthenticated(session.authenticated);
        setAuthUsername(session.username);
      } catch {
        if (cancelled) return;
        setIsAuthenticated(false);
        setAuthUsername(null);
      } finally {
        if (!cancelled) {
          setAuthLoading(false);
        }
      }
    };

    loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!googleClientId || isAuthenticated) {
      return;
    }

    let cancelled = false;

    const renderGoogleButton = () => {
      const google = (window as Window & { google?: any }).google;
      if (!google?.accounts?.id || !googleButtonRef.current || cancelled) {
        return;
      }

      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response: { credential?: string }) => {
          try {
            setLoginError(null);
            const credential = response.credential;
            if (!credential) {
              throw new Error('Google sign-in did not return a credential');
            }

            const session = await loginWithGoogle({ credential });
            setIsAuthenticated(session.authenticated);
            setAuthUsername(session.username);
          } catch (error) {
            setLoginError(error instanceof Error ? error.message : 'Failed to sign in with Google');
          }
        },
      });

      googleButtonRef.current.innerHTML = '';
      google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        width: 320,
        text: 'signin_with',
      });
    };

    const ensureScript = () => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-google-identity-services="true"]');
      if (existing) {
        if (existing.dataset.loaded === 'true') {
          renderGoogleButton();
          return;
        }

        existing.addEventListener('load', renderGoogleButton, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentityServices = 'true';
      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        renderGoogleButton();
      }, { once: true });
      document.head.appendChild(script);
    };

    ensureScript();

    return () => {
      cancelled = true;
    };
  }, [googleClientId, isAuthenticated]);

  const handleLoginSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError(null);

    try {
      const session = await loginRequest({
        username: loginUsername,
        password: loginPassword,
      });
      setIsAuthenticated(session.authenticated);
      setAuthUsername(session.username);
      setLoginPassword('');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Failed to sign in');
    }
  };

  const handleLogout = async () => {
    try {
      await logoutRequest();
    } finally {
      setIsAuthenticated(false);
      setAuthUsername(null);
    }
  };

  const outputs = deriveOutputs(inputRatio, fgDuration);

  const handleOpenDownloadModal = () => {
    setSelectedDownloads(outputs.map(o => o.id));
    setIsDownloadModalOpen(true);
  };

  const handleDownload = async () => {
    if (!fgFile && resizeBatchSources.length === 0) {
      return;
    }

    const selectedOutputs = outputs.filter((output) => selectedDownloads.includes(output.id));

    // Parse custom bitrate (kbps). Empty or invalid → undefined (use default)
    const parsedBitrate = customBitrate.trim() ? parseInt(customBitrate.trim(), 10) : undefined;
    const bitrate = parsedBitrate && parsedBitrate > 0 ? parsedBitrate : undefined;

    if (resizeBatchSources.length > 0) {
      const missingPrimary = selectedOutputs.find((output) => output.trimFrom
        && !selectedOutputs.some((candidate) => candidate.id === output.trimFrom));
      if (missingPrimary) {
        window.alert(`Select ${missingPrimary.trimFrom} before its trim variant`);
        return;
      }
      setIsBatchSubmitting(true);
      setIsDownloadModalOpen(false);
      setIsSidebarOpen(true);
      const addPending = (source: ResizeBatchSource, output: OutputConfig, spec: RenderSpec) => {
        const localId = Math.random().toString(36).slice(2);
        setJobs((current) => [...current, {
          id: localId,
          outputId: `${source.localId}:${output.id}`,
          label: `${source.filename} · ${output.label}`,
          filename: spec.outputFilename,
          spec,
          status: 'submitting',
          progress: 0,
        }]);
        return localId;
      };
      try {
        await submitResizeBatch({
          sources: resizeBatchSources,
          outputs: selectedOutputs,
          config: {
            inputRatio: '9:16', bitrate, fgPosition, bgType, backgroundImageMode, blurAmount,
            logoX, logoY, logoSize, buttonType, buttonText, buttonX, buttonY, buttonSize,
          },
          createJob: async ({ source, output, spec }) => {
            const localId = addPending(source, output, spec);
            try {
              const overlayPng = await createOverlayPng(spec, {
                logoUrl: logo, logoFile, buttonImageUrl: buttonImage, buttonImageFile,
              });
              const result = await createRenderJob({
                spec,
                uploadId: source.uploadId,
                backgroundVideoFile: bgType === 'video' ? bgVideoFile : null,
                backgroundImageFile: bgType === 'image' ? bgImageFile : null,
                overlayPng,
              });
              setJobs((current) => current.map((job) => job.id === localId
                ? { ...job, serverJobId: result.jobId, status: result.status, progress: 0 }
                : job));
              return result;
            } catch (cause) {
              setJobs((current) => current.map((job) => job.id === localId
                ? { ...job, status: 'failed', error: cause instanceof Error ? cause.message : 'Failed to submit job' }
                : job));
              throw cause;
            }
          },
          waitForPrimary: async (primary) => {
            for (let attempt = 0; attempt < 600; attempt += 1) {
              const state = await getRenderJob(primary.jobId);
              if (state.status === 'completed') return primary.jobId;
              if (state.status === 'failed' || state.status === 'cancelled') {
                throw new Error('Source render failed before trim');
              }
              await new Promise((resolve) => window.setTimeout(resolve, 1000));
            }
            throw new Error('Source render timed out before trim');
          },
          createTrimJob: async ({ source, output, spec, sourceJobId }) => {
            const localId = addPending(source, output, spec);
            try {
              const result = await createTrimJob({ spec, sourceJobId });
              setJobs((current) => current.map((job) => job.id === localId
                ? { ...job, serverJobId: result.jobId, status: result.status, progress: 0 }
                : job));
              return result;
            } catch (cause) {
              setJobs((current) => current.map((job) => job.id === localId
                ? { ...job, status: 'failed', error: cause instanceof Error ? cause.message : 'Failed to submit trim job' }
                : job));
              throw cause;
            }
          },
        });
        setResizeBatchSources([]);
      } catch (cause) {
        window.alert(cause instanceof Error ? cause.message : 'Batch submission failed');
      } finally {
        setIsBatchSubmitting(false);
      }
      return;
    }

    // Separate primary renders from trim variants
    const primaryOutputs = selectedOutputs.filter(o => !o.trimFrom);
    const trimOutputs = selectedOutputs.filter(o => !!o.trimFrom);

    const primarySubmissions = primaryOutputs.map((output) => {
      const spec = buildRenderSpec({
        inputRatio,
        outputRatio: output.ratio,
        duration: output.duration ?? fgDuration,
        bitrate,
        fgPosition,
        bgType,
        backgroundImageMode,
        blurAmount,
        logoX,
        logoY,
        logoSize,
        buttonType,
        buttonText,
        buttonX,
        buttonY,
        buttonSize,
        gameName,
        version,
        suffix,
      });

      const localId = Math.random().toString(36).slice(2);
      const pendingJob: RenderJob = {
        id: localId,
        outputId: output.id,
        label: output.label,
        filename: spec.outputFilename,
        spec,
        status: 'submitting',
        progress: 0,
        retryInputs: {
          foregroundFile: fgFile,
          backgroundType: bgType,
          backgroundVideoFile: bgType === 'video' ? bgVideoFile : null,
          backgroundImageFile: bgType === 'image' ? bgImageFile : null,
          logoFile,
          logoUrl: logo,
          buttonImageFile,
          buttonImageUrl: buttonImage,
        },
      };

      return { output, spec, localId, pendingJob };
    });

    flushSync(() => {
      setIsDownloadModalOpen(false);
      setIsSidebarOpen(true);

      if (primarySubmissions.length > 0) {
        setJobs((prev) => [...prev, ...primarySubmissions.map((item) => item.pendingJob)]);
      }
    });

    // Give the browser one frame to paint "submitting" state before heavy network work starts.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    let uploadId: string | undefined;
    if (primaryOutputs.length > 0) {
      try {
        const uploadSession = await createUploadSession({
          foregroundFile: fgFile,
          backgroundVideoFile: bgType === 'video' ? bgVideoFile : null,
          backgroundImageFile: bgType === 'image' ? bgImageFile : null,
        });
        uploadId = uploadSession.uploadId;
      } catch (error) {
        console.error(error);
        setJobs((prev) => prev.map((job) =>
          primarySubmissions.some((item) => item.localId === job.id)
            ? {
              ...job,
              status: 'failed',
              error: error instanceof Error ? error.message : 'Failed to upload source files',
            }
            : job,
        ));
        window.alert(error instanceof Error ? error.message : 'Failed to upload source files');
        return;
      }
    }

    // Track completed primary jobs by output ID for trim job resolution
    const completedPrimaryJobs = new Map<string, string>(); // outputId -> serverJobId

    // Submit primary render jobs
    for (const { spec, localId } of primarySubmissions) {
      try {
        const overlayPng = await createOverlayPng(spec, {
          logoUrl: logo,
          logoFile,
          buttonImageUrl: buttonImage,
          buttonImageFile,
        });

        const result = await createRenderJob({
          spec,
          uploadId,
          overlayPng,
        });

        setJobs((prev) => prev.map((job) =>
          job.id === localId
            ? { ...job, serverJobId: result.jobId, status: result.status, progress: 0 }
            : job,
        ));
      } catch (error) {
        setJobs((prev) => prev.map((job) =>
          job.id === localId
            ? {
              ...job,
              status: 'failed',
              error: error instanceof Error ? error.message : 'Failed to submit job',
            }
            : job,
        ));
      }
    }

    // Submit trim jobs: wait for source primary job to complete, then create trim
    if (trimOutputs.length > 0) {
      // Group trim outputs by their source (trimFrom) output ID
      const trimsBySource = new Map<string, typeof trimOutputs>();
      for (const trimOutput of trimOutputs) {
        const sourceId = trimOutput.trimFrom!;
        if (!trimsBySource.has(sourceId)) {
          trimsBySource.set(sourceId, []);
        }
        trimsBySource.get(sourceId)!.push(trimOutput);
      }

      // For each source, find matching primary job and wait for completion
      for (const [sourceOutputId, trims] of trimsBySource) {
        // Add trim jobs to UI immediately as 'submitting'
        const trimJobLocalIds: { localId: string; output: OutputConfig }[] = [];
        for (const trimOutput of trims) {
          const spec = buildRenderSpec({
            inputRatio,
            outputRatio: trimOutput.ratio,
            duration: trimOutput.duration ?? fgDuration,
            bitrate,
            fgPosition,
            bgType,
            backgroundImageMode,
            blurAmount,
            logoX,
            logoY,
            logoSize,
            buttonType,
            buttonText,
            buttonX,
            buttonY,
            buttonSize,
            gameName,
            version,
            suffix,
          });
          const localId = Math.random().toString(36).slice(2);
          const pendingJob: RenderJob = {
            id: localId,
            outputId: trimOutput.id,
            label: trimOutput.label,
            filename: spec.outputFilename,
            spec,
            status: 'submitting',
            progress: 0,
          };
          setJobs((prev) => [...prev, pendingJob]);
          trimJobLocalIds.push({ localId, output: trimOutput });
        }

        // Wait for the source primary job to complete (poll until completed)
        const waitForSource = async (): Promise<string | null> => {
          // Find the primary job that was submitted for this source output
          const findSourceServerJobId = (): string | undefined => {
            // Get latest jobs state
            let sourceServerJobId: string | undefined;
            setJobs(prev => {
              const sourceJob = prev.find(j => j.outputId === sourceOutputId && j.serverJobId);
              sourceServerJobId = sourceJob?.serverJobId;
              return prev; // Don't modify state
            });
            return sourceServerJobId;
          };

          // Poll until source job is completed
          for (let i = 0; i < 600; i++) { // Max ~10 minutes
            await new Promise(r => setTimeout(r, 1000));
            const serverJobId = findSourceServerJobId();
            if (!serverJobId) continue;

            try {
              const state = await getRenderJob(serverJobId);
              if (state.status === 'completed') {
                return serverJobId;
              }
              if (state.status === 'failed' || state.status === 'cancelled') {
                return null; // Source failed, trim cannot proceed
              }
            } catch {
              // Polling error, continue
            }
          }
          return null;
        };

        // Fire and forget: wait for source then submit trims
        (async () => {
          const sourceServerJobId = await waitForSource();
          if (!sourceServerJobId) {
            // Source job failed or timed out - mark all trim jobs as failed
            for (const { localId } of trimJobLocalIds) {
              setJobs(prev => prev.map(j =>
                j.id === localId
                  ? { ...j, status: 'failed', error: 'Source render failed or timed out' }
                  : j
              ));
            }
            return;
          }

          // Submit each trim job
          for (const { localId, output: trimOutput } of trimJobLocalIds) {
            try {
              const spec = buildRenderSpec({
                inputRatio,
                outputRatio: trimOutput.ratio,
                duration: trimOutput.duration,
                bitrate,
                fgPosition,
                bgType,
                backgroundImageMode,
                blurAmount,
                logoX,
                logoY,
                logoSize,
                buttonType,
                buttonText,
                buttonX,
                buttonY,
                buttonSize,
                gameName,
                version,
                suffix,
              });

              const result = await createTrimJob({
                spec,
                sourceJobId: sourceServerJobId,
              });

              setJobs(prev => prev.map(j =>
                j.id === localId
                  ? { ...j, serverJobId: result.jobId, status: result.status, progress: 0 }
                  : j
              ));
            } catch (error) {
              setJobs(prev => prev.map(j =>
                j.id === localId
                  ? { ...j, status: 'failed', error: error instanceof Error ? error.message : 'Failed to submit trim job' }
                  : j
              ));
            }
          }
        })();
      }
    }
  };

  useJobPolling({
    items: jobs,
    isActive: (job) => Boolean(job.serverJobId) && !['completed', 'failed', 'cancelled'].includes(job.status),
    getKey: (job) => job.serverJobId,
    poll: getRenderJob,
    onResult: (job, state) => setJobs((prev) => prev.map((item) => item.id === job.id ? {
      ...item, status: state.status, progress: state.progress, progressMode: state.progressMode,
      error: state.error, downloadUrl: state.downloadUrl, filename: state.outputFilename || item.filename,
      lastPollError: undefined, lastActionError: undefined,
    } : item)),
    onError: (job, error) => setJobs((prev) => prev.map((item) => item.id === job.id ? {
      ...item, lastPollError: error instanceof Error ? error.message : 'Failed to refresh job',
    } : item)),
  });

  const handleCancelJob = async (jobId: string) => {
    const target = jobs.find((job) => job.id === jobId);
    if (!target) {
      return;
    }

    // Store previous status in case we need to revert on failure
    const previousStatus = target.status;

    // Only set to 'cancelling' if we have a serverJobId (meaning it was submitted)
    // This prevents inventing a lifecycle state the backend never knew about
    if (target.serverJobId) {
      setJobs((prev) => prev.map((job) =>
        job.id === jobId ? { ...job, status: 'cancelling', lastActionError: undefined } : job,
      ));
    }

    if (!target.serverJobId) {
      // No server job yet - just cancel locally (wasn't submitted to backend)
      setJobs((prev) => prev.map((job) =>
        job.id === jobId ? { ...job, status: 'cancelled', lastActionError: undefined } : job,
      ));
      return;
    }

    try {
      await cancelRenderJob(target.serverJobId);
    } catch (error) {
      // Cancel failed - revert to previous status since backend never confirmed the cancel
      // Backend remains source of truth for lifecycle
      setJobs((prev) => prev.map((job) =>
        job.id === jobId
          ? {
            ...job,
            status: previousStatus, // Revert to what backend knew
            lastActionError: error instanceof Error ? error.message : 'Failed to cancel job',
          }
          : job,
      ));
    }
  };

  const removeJob = (jobId: string) => {
    setJobs(prev => prev.filter(j => j.id !== jobId));
  };

  // Retry a failed job - creates a NEW backend job with the SAME inputs as original submission
  const handleRetryJob = async (jobId: string) => {
    const targetJob = jobs.find(j => j.id === jobId);
    if (!targetJob || targetJob.status !== 'failed') {
      return;
    }

    // Must have retryInputs from original submission
    if (!targetJob.retryInputs) {
      setJobs(prev => prev.map(job =>
        job.id === jobId
          ? { ...job, error: 'Cannot retry: original submission inputs not available' }
          : job
      ));
      return;
    }

    const { retryInputs } = targetJob;

    // Create new job with new localId, using ORIGINAL submission inputs
    const newLocalId = Math.random().toString(36).slice(2);
    
    const pendingJob: RenderJob = {
      id: newLocalId,
      outputId: targetJob.outputId,
      label: targetJob.label,
      filename: targetJob.filename,
      spec: targetJob.spec,
      status: 'submitting',
      progress: 0,
      // IMPORTANT: Use the stored retryInputs, not current editor state!
        retryInputs: {
          foregroundFile: retryInputs.foregroundFile,
          backgroundType: retryInputs.backgroundType,
          backgroundVideoFile: retryInputs.backgroundVideoFile,
          backgroundImageFile: retryInputs.backgroundImageFile,
          logoFile: retryInputs.logoFile,
          logoUrl: retryInputs.logoUrl,
          buttonImageFile: retryInputs.buttonImageFile,
          buttonImageUrl: retryInputs.buttonImageUrl,
        },
    };

    setJobs(prev => [...prev, pendingJob]);

    try {
      const overlayPng = await createOverlayPng(targetJob.spec, {
        logoUrl: retryInputs.logoUrl ?? undefined,
        logoFile: retryInputs.logoFile ?? undefined,
        buttonImageUrl: retryInputs.buttonImageUrl ?? undefined,
        buttonImageFile: retryInputs.buttonImageFile ?? undefined,
      });

      const result = await createRenderJob({
        spec: targetJob.spec,
        foregroundFile: retryInputs.foregroundFile,
        backgroundVideoFile: retryInputs.backgroundType === 'video' ? retryInputs.backgroundVideoFile ?? null : null,
        backgroundImageFile: retryInputs.backgroundType === 'image' ? retryInputs.backgroundImageFile ?? null : null,
        overlayPng,
      });

      setJobs(prev => prev.map(job =>
        job.id === newLocalId
          ? { ...job, serverJobId: result.jobId, status: result.status, progress: 0 }
          : job
      ));
    } catch (error) {
      setJobs(prev => prev.map(job =>
        job.id === newLocalId
          ? {
            ...job,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Failed to retry job',
          }
          : job
      ));
    }
  };

  // Bulk retry all failed jobs
  const handleBulkRetryFailed = async () => {
    const failedJobs = jobs.filter(j => j.status === 'failed');
    for (const job of failedJobs) {
      await handleRetryJob(job.id);
    }
  };

  // Bulk clear finished/cancelled jobs (not active ones)
  const handleBulkClearFinished = () => {
    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    setJobs(prev => prev.filter(j => !finishedStatuses.includes(j.status)));
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadResult = async (job: RenderJob) => {
    if (!job.serverJobId) {
      return;
    }

    try {
      const blob = await downloadRenderJob(job.serverJobId);
      downloadBlob(blob, job.filename);
    } catch (error) {
      // Track error for UI display, then rethrow so bulk download can collect failures
      setJobs((prev) => prev.map((j) =>
        j.id === job.id
          ? {
            ...j,
            lastActionError: error instanceof Error ? error.message : 'Failed to download',
          }
          : j,
      ));
      // Rethrow so caller (like downloadAllResults) can collect failures
      throw error;
    }
  };

  const downloadAllResults = async () => {
    // Only download jobs that are actually downloadable (have downloadUrl)
    const downloadable = jobs.filter((job) => job.status === 'completed' && job.downloadUrl);
    const failed: string[] = [];
    
    for (const job of downloadable) {
      try {
        await downloadResult(job);
      } catch (err) {
        failed.push(getJobDisplayName(job));
      }
    }
    
    // If any downloads failed, show feedback
    if (failed.length > 0) {
      alert(`Failed to download: ${failed.join(', ')}`);
    }
  };


  const handleFgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      applyForegroundFile(file);
    }
  };

  const applyForegroundFile = (file: File) => {
    setFgVideo(URL.createObjectURL(file));
    setFgFile(file);
    const tempUrl = URL.createObjectURL(file);
    const tempVid = document.createElement('video');
    tempVid.preload = 'metadata';
    tempVid.src = tempUrl;
    tempVid.onloadedmetadata = () => {
      setFgDuration(tempVid.duration);
      URL.revokeObjectURL(tempUrl);
    };

    const detected = parseVideoNamingMeta(file.name);
    const newAutoFields = new Set<string>();

    if (detected.gameName && !gameName) {
      setGameName(detected.gameName);
      newAutoFields.add('gameName');
    }
    if (detected.version && !version) {
      setVersion(detected.version);
      newAutoFields.add('version');
    }
    if (detected.suffix && !suffix) {
      setSuffix(detected.suffix);
      newAutoFields.add('suffix');
    }
    setAutoDetectedFields(newAutoFields);
  };

  const applyBackgroundVideoFile = (file: File) => {
    setBgVideo(URL.createObjectURL(file));
    setBgVideoFile(file);
    setBgType('video');
  };

  const applyBackgroundImageFile = (file: File) => {
    setBgImage(URL.createObjectURL(file));
    setBgImageFile(file);
    setBgType('image');
  };

  const applyLogoFile = (file: File) => {
    setLogo(URL.createObjectURL(file));
    setLogoFile(file);
  };

  const applyButtonImageFile = (file: File) => {
    setButtonImage(URL.createObjectURL(file));
    setButtonImageFile(file);
    setButtonType('image');
  };

  const handleBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      applyBackgroundVideoFile(file);
    }
  };

  const handleBgImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      applyBackgroundImageFile(file);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      applyLogoFile(file);
    }
  };

  const handleButtonImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      applyButtonImageFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragEnter = (zone: DropZoneKey) => (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current[zone] += 1;
    setActiveDropZone(zone);
  };

  const handleDragLeave = (zone: DropZoneKey) => (e: React.DragEvent) => {
    e.preventDefault();

    const nextDepth = Math.max(0, dragDepthRef.current[zone] - 1);
    dragDepthRef.current[zone] = nextDepth;

    if (nextDepth === 0) {
      setActiveDropZone((current) => (current === zone ? null : current));
    }
  };

  const handleDrop = (zone: DropZoneKey) => (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current[zone] = 0;
    setActiveDropZone((current) => (current === zone ? null : current));

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    switch (zone) {
      case 'foreground':
        if (file.type.startsWith('video/')) {
          applyForegroundFile(file);
        }
        break;
      case 'bgVideo':
        if (file.type.startsWith('video/')) {
          applyBackgroundVideoFile(file);
        }
        break;
      case 'bgImage':
        if (file.type.startsWith('image/')) {
          applyBackgroundImageFile(file);
        }
        break;
      case 'logo':
        if (file.type.startsWith('image/')) {
          applyLogoFile(file);
        }
        break;
      case 'buttonImage':
        if (file.type.startsWith('image/')) {
          applyButtonImageFile(file);
        }
        break;
    }
  };


  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  // Reset handlers for logo and button
  // Both handlers perform full reset: transform + asset
  const handleResetLogo = () => {
    const next = createDefaultLogoState();
    setLogo(next.image);
    setLogoFile(next.imageFile);
    setLogoSize(next.size);
    setLogoX(next.x);
    setLogoY(next.y);
  };

  const handleResetButton = () => {
    const next = createDefaultButtonState();
    setButtonType(next.type);
    setButtonText(next.text);
    setButtonSize(next.size);
    setButtonX(next.x);
    setButtonY(next.y);
    setButtonImage(next.image);
    setButtonImageFile(next.imageFile);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-white px-4">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-4">
            <Film className="w-7 h-7 text-blue-400" />
          </div>
          <p className="text-sm text-neutral-400">Checking session...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-white px-4">
        <div className="w-full max-w-md rounded-3xl border border-neutral-800 bg-neutral-900/90 p-8 shadow-2xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
              <Film className="w-6 h-6 text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">ResizeVideo Login</h1>
              <p className="text-sm text-neutral-400">
                {googleClientId ? 'Sign in with Google Workspace to continue' : 'Sign in to continue'}
              </p>
            </div>
          </div>

          {googleClientId ? (
            <div className="space-y-4">
              <div ref={googleButtonRef} className="flex justify-center" />
              {googleWorkspaceDomain && (
                <p className="text-xs text-neutral-500 text-center">
                  Workspace domain: {googleWorkspaceDomain}
                </p>
              )}
              <div className="relative py-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-neutral-800" />
                </div>
                <div className="relative flex justify-center text-[11px] uppercase tracking-[0.3em] text-neutral-500">
                  <span className="bg-neutral-900 px-2">or</span>
                </div>
              </div>
            </div>
          ) : null}

          <form className="space-y-4" onSubmit={handleLoginSubmit}>
            <div>
              <label className="block text-sm text-neutral-300 mb-1.5">Username</label>
              <input
                type="text"
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                autoComplete="username"
              />
            </div>
            <div>
              <label className="block text-sm text-neutral-300 mb-1.5">Password</label>
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                autoComplete="current-password"
              />
            </div>
            {loginError && (
              <p className="text-sm text-red-400">{loginError}</p>
            )}
            <button
              type="submit"
              className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
            >
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'composer' ? (
        <HookComposerPage />
      ) : activeTab === 'library' ? (
        <LocalLibraryPage onSendToResize={(sources) => {
          setResizeBatchSources(sources);
          setInputRatio('9:16');
          setFgDuration(Math.max(...sources.map((source) => source.duration)));
          setActiveTab('resize');
        }} />
      ) : (
    <div className="min-h-screen bg-neutral-950 text-neutral-50 p-4 md:p-8 font-sans selection:bg-blue-500/30">
      <div className="w-full max-w-[1800px] mx-auto grid grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(420px,0.85fr)] gap-8 xl:gap-10 2xl:gap-14">

        {/* Controls Section */}
        <div className="space-y-8 flex flex-col justify-center">
          <div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4 text-white">
              Resize Video <span className="text-blue-500">Tool</span>
            </h1>
            <p className="text-lg text-neutral-400 max-w-xl">
              Upload a 16:9 foreground and background video to create a seamless 9:16 vertical layout for TikTok, Reels, or Shorts.
            </p>
          </div>

          {resizeBatchSources.length > 0 && (
            <ResizeBatchPanel
              sources={resizeBatchSources}
              onRemove={(localId) => setResizeBatchSources((current) => current.filter((source) => source.localId !== localId))}
              onClear={() => setResizeBatchSources([])}
            />
          )}

          {/* Input Format Control */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
              Input Format
            </div>

            {/* Format toggle */}
            <div>
              <label className="block text-xs text-neutral-400 mb-1">Format</label>
              <div className="flex gap-2 bg-neutral-800 p-1 rounded-lg">
                {(['16:9', '9:16'] as const).map((ratio) => (
                  <button
                    key={ratio}
                    onClick={() => { setInputRatio(ratio); }}
                    disabled={resizeBatchSources.length > 0}
                    className={`flex-1 text-sm font-medium py-2 rounded-md transition-colors ${inputRatio === ratio ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'
                      }`}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>

            {/* Tên game */}
            <div>
              <label className="block text-xs text-neutral-400 mb-1">
                Tên game
                {autoDetectedFields.has('gameName') && (
                  <span className="ml-2 text-[10px] text-emerald-400 font-medium">● Auto-detected</span>
                )}
              </label>
              <input
                type="text"
                value={gameName}
                onChange={(e) => {
                  setGameName(e.target.value);
                  setAutoDetectedFields(prev => { const s = new Set(prev); s.delete('gameName'); return s; });
                }}
                placeholder="e.g. HeroWars"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            {/* Version */}
            <div>
              <label className="block text-xs text-neutral-400 mb-1">
                Version
                {autoDetectedFields.has('version') && (
                  <span className="ml-2 text-[10px] text-emerald-400 font-medium">● Auto-detected</span>
                )}
              </label>
              <input
                type="text"
                value={version}
                onChange={(e) => {
                  setVersion(e.target.value);
                  setAutoDetectedFields(prev => { const s = new Set(prev); s.delete('version'); return s; });
                }}
                placeholder="e.g. v1, v02, KR_A"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            {/* Hậu tố */}
            <div>
              <label className="block text-xs text-neutral-400 mb-1">
                Hậu tố
                {autoDetectedFields.has('suffix') && (
                  <span className="ml-2 text-[10px] text-emerald-400 font-medium">● Auto-detected</span>
                )}
              </label>
              <input
                type="text"
                value={suffix}
                onChange={(e) => {
                  setSuffix(e.target.value);
                  setAutoDetectedFields(prev => { const s = new Set(prev); s.delete('suffix'); return s; });
                }}
                placeholder="e.g. A1, Android, EN, UGC"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            {/* Preview tên output */}
            {(gameName || version || suffix) && (
              <div className="bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2">
                <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Preview tên file</div>
                <div className="text-xs text-neutral-300 font-mono break-all">
                  {buildOutputFilename(
                    { gameName: gameName || 'untitled', version: version || 'v1', suffix },
                    inputRatio === '16:9' ? '9:16' : '16:9',
                    fgDuration
                  )}
                </div>
              </div>
            )}
          </div>


          {inputRatio === '9:16' && (
            <div className="mt-4 pt-4 border-t border-neutral-800">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-neutral-300">Foreground Position (16:9 Output)</h3>
              </div>
              <div className="flex bg-neutral-800 p-1 rounded-lg">
                {(['left', 'center', 'right'] as const).map((pos) => (
                  <button
                    key={pos}
                    onClick={() => setFgPosition(pos)}
                    className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors capitalize ${fgPosition === pos ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'}`}
                  >
                    {pos}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Foreground Upload */}
          <div className="bg-neutral-900/50 border border-neutral-800 rounded-2xl p-6 transition-all hover:border-neutral-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-500">
                  <Film className="w-4 h-4" />
                </div>
                Foreground Video
              </h2>
              <span className="text-xs font-medium px-2.5 py-1 bg-neutral-800 text-neutral-300 rounded-full">{inputRatio}</span>
            </div>
            <label
              className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${activeDropZone === 'foreground' ? 'border-blue-500 bg-blue-500/10' : 'border-neutral-700 hover:bg-neutral-800/80 hover:border-blue-500/50'}`}
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter('foreground')}
              onDragLeave={handleDragLeave('foreground')}
              onDrop={handleDrop('foreground')}
            >
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <Upload className={`w-8 h-8 mb-3 transition-colors ${activeDropZone === 'foreground' ? 'text-blue-400' : 'text-neutral-500 group-hover:text-blue-400'}`} />
                <p className="mb-2 text-sm text-neutral-400"><span className="font-semibold text-neutral-200">Click to upload</span> or drag and drop</p>
                <p className="text-xs text-neutral-500">MP4, WebM, or OGG</p>
              </div>
              <input type="file" className="hidden" accept="video/*" onChange={handleFgUpload} />
            </label>
            {fgVideo && <p className="mt-3 text-sm text-green-400 flex items-center gap-2">✓ Foreground video loaded</p>}
          </div>

          {/* Background Upload */}
          <div className="bg-neutral-900/50 border border-neutral-800 rounded-2xl p-6 transition-all hover:border-neutral-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-500">
                  <ImageIcon className="w-4 h-4" />
                </div>
                Background
              </h2>
              <span className="text-xs font-medium px-2.5 py-1 bg-neutral-800 text-neutral-300 rounded-full">{inputRatio}</span>
            </div>

            <div className="flex bg-neutral-800 p-1 rounded-lg mb-4">
              <button
                className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${bgType === 'video' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'}`}
                onClick={() => setBgType('video')}
              >Video (Blurred)</button>
              <button
                className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${bgType === 'image' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'}`}
                onClick={() => setBgType('image')}
              >Banner Image</button>
            </div>

            {bgType === 'image' && (
              <div className="mb-4">
                <div className="flex bg-neutral-800 p-1 rounded-lg">
                  <button
                    className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${backgroundImageMode === 'clean' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'}`}
                    onClick={() => setBackgroundImageMode('clean')}
                  >Banner sạch</button>
                  <button
                    className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${backgroundImageMode === 'precomposed' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'}`}
                    onClick={() => setBackgroundImageMode('precomposed')}
                  >Banner đã có logo/button</button>
                </div>
                {backgroundImageMode === 'precomposed' && (
                  <p className="mt-2 text-xs text-neutral-500">Banner đã có logo/button sẽ tự zoom nền cho output 4:5 và 1:1</p>
                )}
              </div>
            )}

            {bgType === 'video' ? (
              <>
                <label
                  className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${activeDropZone === 'bgVideo' ? 'border-purple-500 bg-purple-500/10' : 'border-neutral-700 hover:bg-neutral-800/80 hover:border-purple-500/50'}`}
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragEnter('bgVideo')}
                  onDragLeave={handleDragLeave('bgVideo')}
                  onDrop={handleDrop('bgVideo')}
                >
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className={`w-8 h-8 mb-3 transition-colors ${activeDropZone === 'bgVideo' ? 'text-purple-400' : 'text-neutral-500 group-hover:text-purple-400'}`} />
                    <p className="mb-2 text-sm text-neutral-400"><span className="font-semibold text-neutral-200">Click to upload</span> or drag and drop</p>
                    <p className="text-xs text-neutral-500">MP4, WebM, or OGG</p>
                  </div>
                  <input type="file" className="hidden" accept="video/*" onChange={handleBgUpload} />
                </label>
                {bgVideo && <p className="mt-3 text-sm text-green-400 flex items-center gap-2">✓ Background video loaded</p>}
              </>
            ) : (
              <>
                <label
                  className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${activeDropZone === 'bgImage' ? 'border-purple-500 bg-purple-500/10' : 'border-neutral-700 hover:bg-neutral-800/80 hover:border-purple-500/50'}`}
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragEnter('bgImage')}
                  onDragLeave={handleDragLeave('bgImage')}
                  onDrop={handleDrop('bgImage')}
                >
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className={`w-8 h-8 mb-3 transition-colors ${activeDropZone === 'bgImage' ? 'text-purple-400' : 'text-neutral-500 group-hover:text-purple-400'}`} />
                    <p className="mb-2 text-sm text-neutral-400"><span className="font-semibold text-neutral-200">Click to upload banner</span></p>
                    <p className="text-xs text-neutral-500">JPG, PNG, or WebP</p>
                  </div>
                  <input type="file" className="hidden" accept="image/*" onChange={handleBgImageUpload} />
                </label>
                {bgImage && <p className="mt-3 text-sm text-green-400 flex items-center gap-2">✓ Banner image loaded</p>}
              </>
            )}
          </div>

          {/* Blur Control */}
          {bgType === 'video' && (
            <div className="bg-neutral-900/50 border border-neutral-800 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-neutral-300">Background Blur Intensity</h2>
                <span className="text-xs font-mono text-neutral-500">{blurAmount}px</span>
              </div>
              <input
                type="range"
                min="0"
                max="64"
                value={blurAmount}
                onChange={(e) => setBlurAmount(Number(e.target.value))}
                className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          )}

          {/* Logo Control */}
          <div className="bg-neutral-900/50 border border-neutral-800 rounded-2xl p-6 transition-all hover:border-neutral-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-500">
                  <ImageIcon className="w-4 h-4" />
                </div>
                Logo Overlay
              </h2>
            </div>

            {!logo ? (
              <label
                className={`flex flex-col items-center justify-center w-full h-24 border-2 border-dashed rounded-xl cursor-pointer transition-all group mb-4 ${activeDropZone === 'logo' ? 'border-emerald-500 bg-emerald-500/10' : 'border-neutral-700 hover:bg-neutral-800/80 hover:border-emerald-500/50'}`}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter('logo')}
                onDragLeave={handleDragLeave('logo')}
                onDrop={handleDrop('logo')}
              >
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <Upload className={`w-6 h-6 mb-2 transition-colors ${activeDropZone === 'logo' ? 'text-emerald-400' : 'text-neutral-500 group-hover:text-emerald-400'}`} />
                  <p className="text-sm text-neutral-400">Upload Logo (Image)</p>
                </div>
                <input type="file" className="hidden" accept="image/*" onChange={handleLogoUpload} />
              </label>
            ) : (
              <div className="flex items-center justify-between bg-neutral-800 rounded-xl p-3 mb-4 border border-neutral-700">
                <span className="text-sm text-emerald-400 flex items-center gap-2">✓ Logo loaded</span>
                <button onClick={() => { setLogo(null); setLogoFile(null); }} className="text-xs text-neutral-400 hover:text-white px-2 py-1 bg-neutral-700 rounded-md">Remove</button>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span>Size</span>
                  <span>{logoSize}%</span>
                </div>
                <input type="range" min="10" max="250" value={logoSize} onChange={(e) => setLogoSize(Number(e.target.value))} className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
              </div>
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span>Position X</span>
                  <span>{logoX}px</span>
                </div>
                <input type="range" min="-500" max="500" value={logoX} onChange={(e) => setLogoX(Number(e.target.value))} className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
              </div>
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span>Position Y</span>
                  <span>{logoY}px</span>
                </div>
                <input type="range" min="-500" max="500" value={logoY} onChange={(e) => setLogoY(Number(e.target.value))} className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
              </div>
              <button
                onClick={handleResetLogo}
                className="w-full mt-2 py-2 px-3 flex items-center justify-center gap-2 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg transition-colors border border-emerald-500/30"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Logo
              </button>
            </div>
          </div>

          {/* Button Control */}
          <div className="bg-neutral-900/50 border border-neutral-800 rounded-2xl p-6 transition-all hover:border-neutral-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-500">
                  <Type className="w-4 h-4" />
                </div>
                Call to Action Button
              </h2>
            </div>

            <div className="flex bg-neutral-800 p-1 rounded-lg mb-4">
              <button
                className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${buttonType === 'text' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'}`}
                onClick={() => setButtonType('text')}
              >Text Style</button>
              <button
                className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${buttonType === 'image' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-white'}`}
                onClick={() => setButtonType('image')}
              >Custom Image</button>
            </div>

            {buttonType === 'text' ? (
              <div className="mb-4">
                <label className="block text-xs text-neutral-400 mb-1">Button Text</label>
                <input
                  type="text"
                  value={buttonText}
                  onChange={(e) => setButtonText(e.target.value)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500 transition-colors"
                  placeholder="Enter button text..."
                />
              </div>
            ) : (
              <div className="mb-4">
                {!buttonImage ? (
                  <label
                    className={`flex flex-col items-center justify-center w-full h-24 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${activeDropZone === 'buttonImage' ? 'border-amber-500 bg-amber-500/10' : 'border-neutral-700 hover:bg-neutral-800/80 hover:border-amber-500/50'}`}
                    onDragOver={handleDragOver}
                    onDragEnter={handleDragEnter('buttonImage')}
                    onDragLeave={handleDragLeave('buttonImage')}
                    onDrop={handleDrop('buttonImage')}
                  >
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <Upload className={`w-6 h-6 mb-2 transition-colors ${activeDropZone === 'buttonImage' ? 'text-amber-400' : 'text-neutral-500 group-hover:text-amber-400'}`} />
                      <p className="text-sm text-neutral-400">Upload Button Image</p>
                    </div>
                    <input type="file" className="hidden" accept="image/*" onChange={handleButtonImageUpload} />
                  </label>
                ) : (
                  <div className="flex items-center justify-between bg-neutral-800 rounded-xl p-3 border border-neutral-700">
                    <span className="text-sm text-amber-400 flex items-center gap-2">✓ Image loaded</span>
                    <button onClick={() => { setButtonImage(null); setButtonImageFile(null); }} className="text-xs text-neutral-400 hover:text-white px-2 py-1 bg-neutral-700 rounded-md">Remove</button>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span>Size</span>
                  <span>{buttonSize}%</span>
                </div>
                <input type="range" min="10" max="250" value={buttonSize} onChange={(e) => setButtonSize(Number(e.target.value))} className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-amber-500" />
              </div>
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span>Position X</span>
                  <span>{buttonX}px</span>
                </div>
                <input type="range" min="-500" max="500" value={buttonX} onChange={(e) => setButtonX(Number(e.target.value))} className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-amber-500" />
              </div>
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span>Position Y</span>
                  <span>{buttonY}px</span>
                </div>
                <input type="range" min="-500" max="500" value={buttonY} onChange={(e) => setButtonY(Number(e.target.value))} className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-amber-500" />
              </div>
              <button
                onClick={handleResetButton}
                className="w-full mt-2 py-2 px-3 flex items-center justify-center gap-2 text-xs font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors border border-amber-500/30"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Button
              </button>
            </div>
          </div>
        </div>

        {/* Preview Section */}
        <div className="flex flex-col items-center xl:sticky xl:top-8 xl:max-h-[calc(100vh-4rem)] xl:overflow-y-auto pb-8 pr-2 scrollbar-thin scrollbar-thumb-neutral-700 scrollbar-track-transparent">
          <div className="w-full flex justify-between items-center mb-6 sticky top-0 z-50 bg-neutral-950/90 backdrop-blur-md py-4 border-b border-neutral-800">
            <h2 className="text-2xl font-bold text-white">Previews</h2>
            <div className="flex items-center gap-3">
              <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-full bg-neutral-800 text-neutral-300 text-sm border border-neutral-700">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>{authUsername ?? 'Signed in'}</span>
              </div>
              <button
                onClick={handleLogout}
                className="px-4 py-2 flex items-center gap-2 text-sm font-medium bg-neutral-800 text-white rounded-full hover:bg-neutral-700 transition-colors"
              >
                Logout
              </button>
              <button
                onClick={toggleMute}
                className="px-4 py-2 flex items-center gap-2 text-sm font-medium bg-neutral-800 text-white rounded-full hover:bg-neutral-700 transition-colors"
              >
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                <span className="hidden sm:inline">{isMuted ? 'Unmute All' : 'Mute All'}</span>
              </button>
              <button
                onClick={handleOpenDownloadModal}
                disabled={!fgVideo && resizeBatchSources.length === 0}
                className="px-4 py-2 flex items-center gap-2 text-sm font-medium bg-blue-600 text-white rounded-full hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-900/20"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Download</span>
              </button>
            </div>
          </div>

          {outputs.filter(o => o.showPreview !== false).map((output) => (
            <PreviewBox
              key={output.id}
              inputRatio={inputRatio}
              outputRatio={output.ratio}
              duration={output.duration}
              label={output.label}
              fgVideo={fgVideo}
              fgPosition={fgPosition}
              bgType={bgType}
              bgVideo={bgVideo}
              bgImage={bgImage}
              backgroundImageMode={backgroundImageMode}
              blurAmount={blurAmount}
              logo={logo}
              logoX={logoX}
              logoY={logoY}
              logoSize={logoSize}
              buttonType={buttonType}
              buttonText={buttonText}
              buttonImage={buttonImage}
              buttonX={buttonX}
              buttonY={buttonY}
              buttonSize={buttonSize}
              isMuted={isMuted}
            />
          ))}
        </div>
      </div>

      {/* Modals and Overlays */}
      {isDownloadModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Download className="w-5 h-5 text-blue-500" />
                Queue For Export
              </h2>
              <button onClick={() => setIsDownloadModalOpen(false)} className="text-neutral-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-neutral-800">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* Bitrate Control */}
            <div className="mb-4">
              <label className="block text-xs text-neutral-400 mb-1.5">Bitrate (kbps)</label>
              <input
                type="number"
                value={customBitrate}
                onChange={(e) => setCustomBitrate(e.target.value)}
                placeholder="Default: 6000 kbps"
                min="500"
                max="50000"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors placeholder:text-neutral-600"
              />
            </div>

            <div className="space-y-3 mb-8 max-h-[60vh] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-neutral-700">
              {outputs.map(output => (
                <label key={output.id} className="flex items-center gap-3 p-3.5 rounded-xl bg-neutral-800/50 border border-neutral-700/50 cursor-pointer hover:bg-neutral-800 transition-colors group">
                  <input
                    type="checkbox"
                    checked={selectedDownloads.includes(output.id)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedDownloads(prev => [...prev, output.id]);
                      else setSelectedDownloads(prev => prev.filter(id => id !== output.id));
                    }}
                    className="w-5 h-5 rounded border-neutral-600 text-blue-500 bg-neutral-700 cursor-pointer"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-neutral-200 group-hover:text-white">{output.label}</span>
                    {output.trimFrom && (
                      <span className="text-[10px] text-amber-400/70 font-medium">⚡ Trim from full-length (fast)</span>
                    )}
                  </div>
                </label>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIsDownloadModalOpen(false)} className="flex-1 py-2.5 rounded-xl font-medium text-neutral-300 bg-neutral-800 hover:bg-neutral-700">Cancel</button>
              <button onClick={handleDownload} disabled={selectedDownloads.length === 0 || isBatchSubmitting} className="flex-1 py-2.5 rounded-xl font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 flex items-center justify-center gap-2">
                <Download className="w-4 h-4" /> Add Queue ({selectedDownloads.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {isSidebarOpen && (
        <div className="fixed inset-y-0 right-0 w-80 bg-neutral-900 border-l border-neutral-800 shadow-2xl z-40 flex flex-col">
          <div className="p-5 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/50">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Film className="w-5 h-5 text-blue-500" /> Render Queue
            </h2>
            <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-neutral-700">
            {jobs.length === 0 ? (
              <div className="text-center text-neutral-500 py-12 flex flex-col items-center">
                <Film className="w-8 h-8 mb-3 opacity-20" />
                <span className="text-sm">No active tasks</span>
              </div>
            ) : (
              jobs.map(job => (
                <div key={job.id} className="bg-neutral-800/40 border border-neutral-700/80 rounded-xl p-4 flex flex-col gap-3 group relative overflow-hidden transition-all">
                  <div className="flex items-start justify-between relative z-10">
                    <div className="pr-12">
                      <h4 className="text-sm font-medium text-white line-clamp-1">{getJobDisplayName(job)}</h4>
                      <p className={`text-xs mt-0.5 font-medium ${job.status === 'processing' ? 'text-blue-400 animate-pulse' : job.status === 'completed' ? 'text-green-400' : job.status === 'failed' ? 'text-red-400' : 'text-neutral-400 capitalize'}`}>
                        {job.status === 'processing' && job.progressMode === 'indeterminate' ? 'Processing...' : job.status}
                      </p>
                      {/* Show polling error if exists */}
                      {job.lastPollError && (
                        <p className="text-[10px] mt-0.5 text-amber-400">Network error: {job.lastPollError}</p>
                      )}
                      {/* Show action error if exists (cancel, download failures) */}
                      {job.lastActionError && (
                        <p className="text-[10px] mt-0.5 text-amber-400">Action error: {job.lastActionError}</p>
                      )}
                      {/* Show error message for failed jobs */}
                      {job.status === 'failed' && job.error && (
                        <p className="text-[10px] mt-0.5 text-red-400 truncate">{job.error}</p>
                      )}
                    </div>
                    <div className="absolute right-0 top-0 flex gap-1">
                      {(job.status === 'submitting' || job.status === 'queued' || job.status === 'processing' || job.status === 'cancelling') && (
                        <button onClick={() => handleCancelJob(job.id)} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 rounded">Cancel</button>
                      )}
                      {job.status === 'failed' && (
                        <button onClick={() => handleRetryJob(job.id)} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400 hover:text-amber-300 bg-amber-400/10 hover:bg-amber-400/20 rounded">Retry</button>
                      )}
                      {(job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') && (
                        <button onClick={() => removeJob(job.id)} className="p-1 w-6 h-6 flex items-center justify-center text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/50 rounded transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  {job.status === 'processing' && (
                    <div className="relative z-10">
                      <div className="flex justify-between items-end mb-1.5">
                        <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Progress</span>
                        <span className="text-xs font-medium text-white">
                          {job.progressMode === 'indeterminate' ? 'Unknown duration' : `${job.progress}%`}
                        </span>
                      </div>
                      <div className="w-full bg-neutral-950 rounded-full h-1.5 overflow-hidden ring-1 ring-white/5">
                        <div className={`h-full transition-all duration-300 ease-out relative ${job.progressMode === 'indeterminate' ? 'bg-amber-500 animate-pulse w-full' : 'bg-blue-500'}`} style={{ width: job.progressMode === 'indeterminate' ? '100%' : `${job.progress}%` }}>
                          {job.progressMode !== 'indeterminate' && <div className="absolute inset-0 bg-white/20 w-full animate-progress-shimmer"></div>}
                        </div>
                      </div>
                    </div>
                  )}
                  {job.status === 'completed' && job.downloadUrl && (
                    <button onClick={() => downloadResult(job)} className="relative z-10 w-full mt-1 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold uppercase tracking-wider rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-blue-900/40">
                      <Download className="w-3.5 h-3.5" /> Save Video
                    </button>
                  )}
                  {job.status === 'processing' && (
                    <div className="absolute bottom-0 left-0 h-0.5 bg-blue-500/50 transition-all duration-300" style={{ width: job.progressMode === 'indeterminate' ? '100%' : `${job.progress}%` }}></div>
                  )}
                </div>

              ))
            )}
            {jobs.some(job => job.status === 'completed' && job.downloadUrl) && (
              <button
                onClick={downloadAllResults}
                className="w-full py-2.5 bg-green-600 hover:bg-green-500 text-white text-xs font-bold uppercase tracking-wider rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-green-900/40 mt-2"
              >
                <Download className="w-3.5 h-3.5" /> Download All
              </button>
            )}
            {/* Bulk actions */}
            {jobs.some(job => job.status === 'failed') && (
              <button
                onClick={handleBulkRetryFailed}
                className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold uppercase tracking-wider rounded-lg transition-all flex items-center justify-center gap-2 mt-2"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Retry All Failed
              </button>
            )}
            {jobs.some(job => ['completed', 'failed', 'cancelled'].includes(job.status)) && (
              <button
                onClick={handleBulkClearFinished}
                className="w-full py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 text-xs font-bold uppercase tracking-wider rounded-lg transition-all flex items-center justify-center gap-2 mt-2"
              >
                Clear Finished
              </button>
            )}
          </div>
        </div>
      )}

      {!isSidebarOpen && jobs.length > 0 && (
        <button onClick={() => setIsSidebarOpen(true)} className="fixed bottom-6 right-6 z-40 bg-blue-600 text-white p-4 rounded-full shadow-2xl hover:bg-blue-500 transition-transform hover:scale-[1.05] group flex items-center justify-center">
          <div className="relative">
            <Film className="w-6 h-6" />
            <span className="absolute -top-3 -right-3 bg-red-500 text-white text-[11px] font-bold w-6 h-6 rounded-full flex items-center justify-center border-2 border-neutral-900">
              {jobs.filter(j => ['submitting', 'queued', 'processing', 'cancelling'].includes(j.status)).length}
            </span>
          </div>
        </button>
      )}
    </div>
      )}
    </AppShell>
  );
}
