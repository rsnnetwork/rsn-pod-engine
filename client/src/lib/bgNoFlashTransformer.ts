// Vendored, MINIMAL fork of @livekit/track-processors' BackgroundTransformer
// (Bug④, 2026-06-08). ONE deliberate delta vs the stock transformer; every
// other line mirrors it so the maintained gl/stream pipeline (VideoTransformer
// base + BackgroundProcessorWrapper, both still imported from the library) is
// untouched, and the mask source is the SAME proven CATEGORY mask the stock
// path uses — identical compositing, zero edge-quality risk:
//
//   NO FIRST-FRAME RAW FLASH. The stock transformer enqueues an UNPROCESSED
//   clone of the very first frame (to mask cold model-load) — which briefly
//   reveals the user's real background on apply (Ali's manual test, image 1).
//   We prewarm the model, so the first frame is processed normally; the raw
//   enqueue is dropped.
//
// NOTE (confidence mask, parked): switching to outputConfidenceMasks for
// genuinely accurate feathered edges was prototyped and REJECTED in pre-prod
// testing — the selfie confidence mask is person-probability (high on the
// person) but the library's composite shader treats HIGH mask = background, so
// it composites inverted (replaces the person, keeps the room). Correcting it
// needs a per-frame CPU mask inversion (perf cost) or forking the WebGL shader
// (setupWebGL) — a larger, riskier vendor deferred to its own effort. Until
// then the edge quality stays at the stock model's level (= Google Meet basic).
//
// Flag-gated (featureFlags.BG_NOFLASH_TRANSFORMER). As of 2026-06-09 it runs on
// EVERY supported path â€” modern (Chrome/Edge) AND the canvas.captureStream
// fallback (iOS Safari / older Android) â€” because the first-frame raw flash is
// exactly what phone users saw on apply. It subclasses the library's
// VideoTransformer, so ProcessorWrapper drives it identically on both paths;
// flag-off reverts to the stock BackgroundProcessor everywhere.
import { VideoTransformer } from '@livekit/track-processors';
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type * as vision from '@mediapipe/tasks-vision';

export type SegmenterOptions = Partial<vision.ImageSegmenterOptions['baseOptions']>;

export interface FrameProcessingStats {
  processingTimeMs: number;
  segmentationTimeMs: number;
  filterTimeMs: number;
}

export type NoFlashBackgroundOptions = {
  blurRadius?: number;
  imagePath?: string;
  backgroundDisabled?: boolean;
  segmenterOptions?: SegmenterOptions;
  assetPaths?: { tasksVisionFileSet?: string; modelAssetPath?: string };
  onFrameProcessed?: (stats: FrameProcessingStats) => void;
};

export class NoFlashBackgroundTransformer extends VideoTransformer<NoFlashBackgroundOptions> {
  imageSegmenter?: vision.ImageSegmenter;
  segmentationResults: vision.ImageSegmenterResult | undefined;
  backgroundImageAndPath: { imageData: ImageBitmap; path: string } | null = null;
  options: NoFlashBackgroundOptions;
  segmentationTimeMs = 0;
  isFirstFrame = true;
  // The `WIDTHxHEIGHT` the image background was last cover-cropped for. The
  // library covers the bitmap to canvas.width/height ONCE (at set time); if the
  // frame dimensions later change (mobile rotation, or a device that ignored the
  // 960x540 capture constraint) the crop goes stale and the image letterboxes or
  // stretches. We re-cover whenever this key changes so an image background stays
  // fully fitted on every device/orientation. '' = not yet covered.
  private bgFitKey = '';

  constructor(opts: NoFlashBackgroundOptions) {
    super();
    this.options = opts;
    this.update(opts);
  }

  async init({ outputCanvas, inputElement: inputVideo }: { outputCanvas: any; inputElement: any }) {
    await super.init({ outputCanvas, inputElement: inputVideo });

    const fileSet = await FilesetResolver.forVisionTasks(
      this.options.assetPaths?.tasksVisionFileSet ??
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
    );

    this.imageSegmenter = await ImageSegmenter.createFromOptions(fileSet, {
      baseOptions: {
        modelAssetPath:
          this.options.assetPaths?.modelAssetPath ??
          'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
        delegate: 'GPU',
        ...this.options.segmenterOptions,
      },
      canvas: this.canvas as any,
      runningMode: 'VIDEO',
      // SAME proven mask source as the stock transformer (correct shader
      // orientation). Confidence mask is parked — see file header.
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });

    if (this.options?.imagePath) {
      await this.loadAndSetBackground(this.options.imagePath).catch(() => {});
    }
    if (typeof this.options.blurRadius === 'number') {
      this.gl?.setBlurRadius(this.options.blurRadius);
    }
    this.gl?.setBackgroundDisabled(this.options.backgroundDisabled ?? false);
  }

  async destroy() {
    await super.destroy();
    await this.imageSegmenter?.close();
    this.backgroundImageAndPath = null;
    this.isFirstFrame = true;
    this.bgFitKey = '';
  }

  async loadAndSetBackground(path: string) {
    if (!this.backgroundImageAndPath || this.backgroundImageAndPath?.path !== path) {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.crossOrigin = 'Anonymous';
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(err);
        img.src = path;
      });
      const imageData = await createImageBitmap(img);
      this.backgroundImageAndPath = { imageData, path };
    }
    this.gl?.setBackgroundImage(this.backgroundImageAndPath.imageData);
    // Record the dimensions we just covered for, so transform() only re-covers
    // when the frame size actually changes.
    this.bgFitKey = this.canvas ? `${this.canvas.width}x${this.canvas.height}` : '';
  }

  async transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    let enqueuedFrame = false;
    try {
      if (!(frame instanceof VideoFrame) || frame.codedWidth === 0 || frame.codedHeight === 0) {
        return;
      }

      let skipProcessingFrame = (this as any).isDisabled ?? this.options.backgroundDisabled ?? false;
      if (typeof this.options.blurRadius !== 'number' && typeof this.options.imagePath !== 'string') {
        skipProcessingFrame = true;
      }
      if (skipProcessingFrame) {
        controller.enqueue(frame);
        enqueuedFrame = true;
        return;
      }

      const frameTimeMs = Date.now();
      if (!this.canvas) throw TypeError('Canvas needs to be initialized first');
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;

      // Keep an IMAGE background fully covering the ACTUAL frame. The library
      // crops the bitmap to canvas dims only when setBackgroundImage is called;
      // if the frame size changes afterwards (rotation, constraint ignored) the
      // crop is stale and the room shows at the edges. switchTo reliably clears
      // imagePath on blur/disabled, so this never fires outside image mode. The
      // re-cover (createImageBitmap) runs only on a genuine dimension change.
      if (typeof this.options.imagePath === 'string' && this.backgroundImageAndPath) {
        const fitKey = `${this.canvas.width}x${this.canvas.height}`;
        if (fitKey !== this.bgFitKey) {
          this.bgFitKey = fitKey;
          void this.gl?.setBackgroundImage(this.backgroundImageAndPath.imageData);
        }
      }

      // DELTA — the stock transformer enqueues an UNPROCESSED clone here on the
      // first frame (flash of the real room). We prewarm the model, so process
      // the first frame normally instead. isFirstFrame kept only to mirror the
      // field; no raw enqueue.
      this.isFirstFrame = false;

      const filterStartTimeMs = performance.now();
      const segmentationPromise = new Promise<void>((resolve, reject) => {
        try {
          const segStart = performance.now();
          this.imageSegmenter?.segmentForVideo(frame, segStart, (result) => {
            this.segmentationTimeMs = performance.now() - segStart;
            this.segmentationResults = result;
            if (result.categoryMask) this.gl?.updateMask(result.categoryMask.getAsWebGLTexture());
            result.close();
            resolve();
          });
        } catch (e) {
          reject(e);
        }
      });

      this.gl?.renderFrame(frame);
      if (this.canvas && this.canvas.width > 0 && this.canvas.height > 0) {
        const newFrame = new VideoFrame(this.canvas as any, { timestamp: frame.timestamp || frameTimeMs });
        controller.enqueue(newFrame);
        const filterTimeMs = performance.now() - filterStartTimeMs;
        this.options.onFrameProcessed?.({
          processingTimeMs: this.segmentationTimeMs + filterTimeMs,
          segmentationTimeMs: this.segmentationTimeMs,
          filterTimeMs,
        });
      } else {
        controller.enqueue(frame);
      }
      await segmentationPromise;
    } catch {
      /* drop this frame; next one recovers */
    } finally {
      if (!enqueuedFrame) {
        try { frame.close(); } catch { /* already closed */ }
      }
    }
  }

  async update(opts: NoFlashBackgroundOptions) {
    this.options = { ...this.options, ...opts };
    this.gl?.setBlurRadius(opts.blurRadius ?? null);
    if (opts.imagePath) {
      await this.loadAndSetBackground(opts.imagePath);
    } else {
      this.gl?.setBackgroundImage(null);
      this.bgFitKey = ''; // no image active; re-cover on the next image apply
    }
    this.gl?.setBackgroundDisabled(opts.backgroundDisabled ?? false);
  }
}
