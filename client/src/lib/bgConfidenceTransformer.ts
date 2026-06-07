// Vendored, MINIMAL fork of @livekit/track-processors' BackgroundTransformer
// (Bug④, 2026-06-08). Two deliberate deltas vs the stock transformer; EVERY
// other line mirrors it so the maintained gl/stream pipeline (VideoTransformer
// base + ProcessorWrapper, both still imported from the library) is untouched:
//
//   1. CONFIDENCE MASK instead of CATEGORY MASK. The stock transformer requests
//      outputCategoryMask (hard 0/1) and the WebGL composite shader fakes a soft
//      edge with an 8px box-blur + smoothstep — which spreads the silhouette and
//      bleeds the real room in around the body. A confidence mask is a true
//      0..1 per-pixel probability; the SAME shader then feathers a genuinely
//      accurate edge with no logic change. This is the desktop "sharper edges"
//      win (Ali's manual test, image 1).
//
//   2. NO FIRST-FRAME RAW FLASH. The stock transformer enqueues an UNPROCESSED
//      clone of the very first frame (to avoid a solid-colour flash during cold
//      model load) — which briefly reveals the user's real background on apply.
//      We prewarm the model, so the first frame can be processed normally; the
//      raw enqueue is dropped.
//
// Flag-gated (featureFlags.BG_CONFIDENCE_MASK) and used ONLY on the modern API
// path; mobile / fallback / flag-off keep the stock BackgroundProcessor. If the
// confidence mask ever proves inverted on some model build, flip
// CONFIDENCE_MASK_INVERT — the shader convention (high mask = background) is the
// same one the category mask satisfied.
import { VideoTransformer } from '@livekit/track-processors';
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type * as vision from '@mediapipe/tasks-vision';

export type SegmenterOptions = Partial<vision.ImageSegmenterOptions['baseOptions']>;

export interface FrameProcessingStats {
  processingTimeMs: number;
  segmentationTimeMs: number;
  filterTimeMs: number;
}

export type ConfidenceBackgroundOptions = {
  blurRadius?: number;
  imagePath?: string;
  backgroundDisabled?: boolean;
  segmenterOptions?: SegmenterOptions;
  assetPaths?: { tasksVisionFileSet?: string; modelAssetPath?: string };
  onFrameProcessed?: (stats: FrameProcessingStats) => void;
};

/** The selfie confidence mask is foreground-probability; the stock shader's
 *  convention (validated by the category-mask path) treats the sampled value
 *  such that this orientation composites correctly. If a future model build
 *  inverts it (person replaced instead of background), set this true. */
const CONFIDENCE_MASK_INVERT = false;

export class ConfidenceBackgroundTransformer extends VideoTransformer<ConfidenceBackgroundOptions> {
  imageSegmenter?: vision.ImageSegmenter;
  segmentationResults: vision.ImageSegmenterResult | undefined;
  backgroundImageAndPath: { imageData: ImageBitmap; path: string } | null = null;
  options: ConfidenceBackgroundOptions;
  segmentationTimeMs = 0;
  isFirstFrame = true;

  constructor(opts: ConfidenceBackgroundOptions) {
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
      // DELTA 1 — soft per-pixel probability instead of the hard category mask.
      outputCategoryMask: false,
      outputConfidenceMasks: true,
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

      // DELTA 2 — the stock transformer enqueues an UNPROCESSED clone here on
      // the first frame (flash of the real room). We prewarm the model, so we
      // process the first frame normally instead. isFirstFrame is kept only to
      // mirror the field; no raw enqueue.
      this.isFirstFrame = false;

      const filterStartTimeMs = performance.now();
      const segmentationPromise = new Promise<void>((resolve, reject) => {
        try {
          const segStart = performance.now();
          this.imageSegmenter?.segmentForVideo(frame, segStart, (result) => {
            this.segmentationTimeMs = performance.now() - segStart;
            this.segmentationResults = result;
            // DELTA 1 — feed the confidence mask (soft 0..1) to the same gl path.
            const mask = result.confidenceMasks?.[0];
            if (mask) this.gl?.updateMask(mask.getAsWebGLTexture());
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

  async update(opts: ConfidenceBackgroundOptions) {
    this.options = { ...this.options, ...opts };
    this.gl?.setBlurRadius(opts.blurRadius ?? null);
    if (opts.imagePath) {
      await this.loadAndSetBackground(opts.imagePath);
    } else {
      this.gl?.setBackgroundImage(null);
    }
    this.gl?.setBackgroundDisabled(opts.backgroundDisabled ?? false);
  }
}

// Referenced so the invert constant isn't tree-shaken before it's wired into a
// future mask-orientation toggle; documents the known escape hatch.
export const CONFIDENCE_MASK_INVERT_ACTIVE = CONFIDENCE_MASK_INVERT;
