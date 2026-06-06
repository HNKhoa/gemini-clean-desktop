import * as MP4Box from './vendor/mp4box.all.js';
import * as Mp4Muxer from './vendor/mp4-muxer.mjs';

const VIDEO_INTENSITY = 0.60;
const VIDEO_OUTLINE_WIDTH = 2;
const VIDEO_INPAINT_RADIUS = 4;
const MAX_VIDEO_WORKERS = 12;
const MAX_DECODE_QUEUE = 18;
// Cap how many frames sit in the encoder's queue. Without this the encoder is
// flooded with every frame at once; its internal buffer then holds gigabytes of
// raw frame data and the codec stalls / gets "reclaimed due to inactivity"
// (notably on long 4K clips). We stop decoding when the queue is full and resume
// from the encoder's output callback as it drains.
const MAX_ENCODE_QUEUE = 12;

function normalizeFps(fps) {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return 30;
  return Math.max(1, Math.min(120, fps));
}

function chooseAvcCodec(width, height, fps) {
  const pixels = width * height;
  if (pixels > 1920 * 1080) return 'avc1.640033';
  if (fps > 30) return 'avc1.64002A';
  return 'avc1.640028';
}

function chooseExportBitrate(width, height, trackInfo, fps) {
  const pixels = width * height;
  // Resolution-based target (computed on the OUTPUT size). Keeps software encode
  // fast and file sizes sane. ~12 Mbps @ 1080p30, ~5.5 @ 720p30.
  const target = Math.round(pixels * fps * 0.2);
  return Math.min(28_000_000, Math.max(8_000_000, target));
}

// Downscale a (w,h) so its long side is <= maxDim, preserving aspect ratio and
// keeping both dimensions even (required by H.264). Returns the original if
// already within maxDim or maxDim is falsy.
function fitWithin(width, height, maxDim) {
  if (!maxDim || Math.max(width, height) <= maxDim) return { width, height };
  const scale = maxDim / Math.max(width, height);
  const w = Math.max(2, Math.round((width * scale) / 2) * 2);
  const h = Math.max(2, Math.round((height * scale) / 2) * 2);
  return { width: w, height: h };
}

// Pick a VideoEncoder config the current machine actually supports.
// Some hardware H.264 encoders reject configs that software encoders accept
// (e.g. a bitrate above the codec level cap), which surfaces as the async
// "Encoder creation error". We probe candidates with isConfigSupported() —
// preferring the requested quality, then a higher level, then lower bitrate —
// and DON'T force hardware, so the browser can fall back to software when the
// hardware encoder can't honor the config.
async function pickSupportedVideoEncoderConfig(base, preferredCodec, targetBitrate) {
  const HIGH_L51 = 'avc1.640033'; // High@L5.1 — allows higher bitrate/resolution
  const codecs = preferredCodec === HIGH_L51 ? [HIGH_L51] : [preferredCodec, HIGH_L51];
  const bitrates = [];
  for (const b of [targetBitrate, 24_000_000, 12_000_000]) {
    const v = Math.max(2_000_000, Math.min(targetBitrate, b));
    if (!bitrates.includes(v)) bitrates.push(v);
  }
  const candidates = [];
  const seen = new Set();
  for (const codec of codecs) {
    for (const bitrate of bitrates) {
      const key = codec + ':' + bitrate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...base, codec, bitrate, hardwareAcceleration: 'no-preference', latencyMode: 'quality' });
    }
  }
  if (typeof VideoEncoder !== 'undefined' && typeof VideoEncoder.isConfigSupported === 'function') {
    for (const cfg of candidates) {
      try {
        const probe = await VideoEncoder.isConfigSupported(cfg);
        if (probe && probe.supported) return probe.config || cfg;
      } catch (_) { /* try next candidate */ }
    }
  }
  // Last resort if nothing probed as supported.
  return { ...base, codec: preferredCodec, bitrate: 12_000_000, hardwareAcceleration: 'no-preference', latencyMode: 'quality' };
}

// Pick a VideoDecoder config the machine can actually decode. Hardware H.264
// decoders frequently fail on large/odd resolutions (e.g. 2160x3840 4K
// vertical), which surfaces as an async "Decoding error". For large frames we
// try SOFTWARE first (reliable at any resolution); for small frames hardware
// first (fast). isConfigSupported() narrows to a config the browser accepts.
async function pickSupportedDecoderConfig(config) {
  const pixels = (config.codedWidth || 0) * (config.codedHeight || 0);
  const large = pixels > 1920 * 1080;
  const accels = large ? ['prefer-software', 'no-preference'] : ['no-preference', 'prefer-software'];
  if (typeof VideoDecoder !== 'undefined' && typeof VideoDecoder.isConfigSupported === 'function') {
    for (const accel of accels) {
      const cfg = { ...config, hardwareAcceleration: accel };
      try {
        const probe = await VideoDecoder.isConfigSupported(cfg);
        if (probe && probe.supported) return probe.config || cfg;
      } catch (_) { /* try next candidate */ }
    }
  }
  return { ...config, hardwareAcceleration: large ? 'prefer-software' : 'no-preference' };
}

function cleanBaseName(filename) {
  const dotIndex = filename.lastIndexOf('.');
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return base.replace(/[^\w.-]+/g, '_') || 'video';
}

function getWatermarkConfig(width, height) {
  let logoSize = 48;
  let marginRight = 72;
  let marginBottom = 72;

  if (Math.max(width, height) >= 3840) {
    logoSize = 96;
    marginRight = 64;
    marginBottom = 64;
  } else if (Math.max(width, height) >= 1920) {
    logoSize = 72;
    marginRight = 108;
    marginBottom = 108;
  }

  return {
    logoSize,
    x: Math.max(0, width - marginRight - logoSize),
    y: Math.max(0, height - marginBottom - logoSize),
    w: logoSize,
    h: logoSize
  };
}

function getSampleDescription(mp4boxfile, track) {
  const trak = mp4boxfile.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    if (entry.avcC || entry.hvcC || entry.vpcC || entry.av1C) {
      const stream = new MP4Box.DataStream(undefined, 0, 1);
      if (entry.avcC) entry.avcC.write(stream);
      else if (entry.hvcC) entry.hvcC.write(stream);
      else if (entry.vpcC) entry.vpcC.write(stream);
      else if (entry.av1C) entry.av1C.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}

async function extractFrames(file, onConfig, onChunk, onFinish, onAudioChunk) {
  const mp4boxfile = MP4Box.createFile();

  return new Promise((resolve, reject) => {
    mp4boxfile.onError = (error) => reject(error);

    mp4boxfile.onReady = (info) => {
      const track = info.videoTracks?.[0];
      if (!track) {
        reject(new Error('No video track found. MP4/MOV input is required.'));
        return;
      }

      const audioTrack = info.audioTracks?.[0];
      const audioCodec = audioTrack?.codec?.startsWith('mp4a')
        ? 'aac'
        : audioTrack?.codec === 'opus'
          ? 'opus'
          : null;
      const audioInfo = audioTrack && audioCodec && audioTrack.audio?.sample_rate && audioTrack.audio?.channel_count
        ? {
          codec: audioCodec,
          codecString: audioTrack.codec,
          frameCount: audioTrack.nb_samples ?? audioTrack.nbSamples ?? 0,
          sampleRate: audioTrack.audio.sample_rate,
          numberOfChannels: audioTrack.audio.channel_count,
          bitrate: audioTrack.bitrate,
          durationSeconds: audioTrack.duration && audioTrack.timescale
            ? audioTrack.duration / audioTrack.timescale
            : undefined
        }
        : undefined;

      const durationSeconds = track.duration && track.timescale
        ? track.duration / track.timescale
        : info.duration && info.timescale
          ? info.duration / info.timescale
          : undefined;
      const frameCount = track.nb_samples ?? track.nbSamples ?? 0;
      const frameRate = durationSeconds && frameCount ? frameCount / durationSeconds : undefined;
      const bitrate = track.bitrate ?? (durationSeconds && track.size ? Math.round((track.size * 8) / durationSeconds) : undefined);

      onConfig({
        codec: track.codec,
        codedHeight: track.video.height,
        codedWidth: track.video.width,
        description: getSampleDescription(mp4boxfile, track)
      }, {
        frameCount,
        frameRate,
        bitrate,
        durationSeconds
      }, audioInfo, !!audioTrack && !audioInfo);

      mp4boxfile.setExtractionOptions(track.id, { kind: 'video' }, { nbSamples: 1000 });
      if (audioTrack && audioInfo && onAudioChunk) {
        mp4boxfile.setExtractionOptions(audioTrack.id, { kind: 'audio' }, { nbSamples: 1000 });
      }
      mp4boxfile.start();
    };

    mp4boxfile.onSamples = (_trackId, user, samples) => {
      for (const sample of samples) {
        if (user?.kind === 'audio') {
          onAudioChunk?.({
            data: sample.data,
            type: 'key',
            timestamp: 1000000 * sample.cts / sample.timescale,
            duration: 1000000 * sample.duration / sample.timescale
          });
          continue;
        }

        onChunk(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: 1000000 * sample.cts / sample.timescale,
          duration: 1000000 * sample.duration / sample.timescale,
          data: sample.data
        }));
      }
    };

    file.arrayBuffer().then((buffer) => {
      buffer.fileStart = 0;
      mp4boxfile.appendBuffer(buffer);
      mp4boxfile.flush();
      setTimeout(() => {
        onFinish();
        resolve();
      }, 1000);
    }).catch(reject);
  });
}

export async function processVideoWatermarkMp4(file, onProgress, signal, options = {}) {
  if (!('VideoDecoder' in window) || !('VideoEncoder' in window)) {
    throw new Error('Chrome WebCodecs is required for MP4 video processing.');
  }
  if (signal?.aborted) throw new Error('Cancelled');

  // Cap the OUTPUT long side (0 = keep original). Large inputs (4K) are
  // downscaled so software H.264 encode stays fast and memory stays bounded.
  const maxOutputDimension = Number(options.maxOutputDimension) > 0 ? Number(options.maxOutputDimension) : 0;

  const startedAt = Date.now();
  const workers = [];

  return new Promise((resolve, reject) => {
    let muxer = null;
    let videoEncoder = null;
    let videoDecoder = null;
    let frameCount = 0;
    let totalEncoded = 0;
    let isFinalizing = false;
    let encoderConfigured = false;
    let exportFps = 30;
    let keyFrameInterval = 60;
    let estimatedTotalFrames = 1;
    let outputWidth = 0;
    let outputHeight = 0;
    let srcWidth = 0;
    let srcHeight = 0;
    let scaleCanvas = null;
    let scaleCtx = null;
    let box = getWatermarkConfig(1920, 1080);
    let pendingFrames = 0;
    let frameOrder = [];
    let chunkCount = 0;
    let decodeFinishedCount = 0;
    let isExtractionFinished = false;
    let workerIdx = 0;
    let unsupportedAudioWarning = '';
    let drawCanvas = null;
    let drawCtx = null;
    let aborted = false;
    let decodeQueue = [];
    let decoderFlushStarted = false;
    let decoderFlushed = false;
    let maxPendingFrames = 24;

    const cleanup = () => {
      signal?.removeEventListener?.('abort', abortHandler);
      workers.forEach((worker) => worker.terminate());
      frameOrder.forEach((frame) => {
        frame.originalFrameBitmap?.close?.();
        frame.processedBox?.close?.();
      });
      frameOrder = [];
      decodeQueue = [];
      try { videoDecoder?.close?.(); } catch (_) { /* ignore */ }
      try { videoEncoder?.close?.(); } catch (_) { /* ignore */ }
    };

    const fail = (error) => {
      if (isFinalizing) return;
      isFinalizing = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const abortHandler = () => {
      aborted = true;
      fail(new Error('Cancelled'));
    };
    signal?.addEventListener?.('abort', abortHandler, { once: true });

    const checkAbort = () => {
      if (aborted || signal?.aborted) {
        throw new Error('Cancelled');
      }
    };

    const finishExport = async () => {
      if (isFinalizing) return;
      checkAbort();
      isFinalizing = true;
      try {
        if (!muxer || !videoEncoder) {
          throw new Error('Video encoder was not initialized.');
        }
        await videoEncoder.flush();
        muxer.finalize();
        const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
        const previewUrl = URL.createObjectURL(blob);
        cleanup();
        resolve({
          blob,
          filename: `clean_${cleanBaseName(file.name)}.mp4`,
          mimeType: 'video/mp4',
          previewUrl,
          width: outputWidth,
          height: outputHeight,
          meta: {
            watermarkBox: { x: box.x, y: box.y, w: box.w, h: box.h },
            intensity: VIDEO_INTENSITY,
            outlineWidth: VIDEO_OUTLINE_WIDTH,
            inpaintRadius: VIDEO_INPAINT_RADIUS,
            warning: unsupportedAudioWarning
          }
        });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const maybeFinishExport = () => {
      // Done when extraction finished, the decoder fully flushed (every frame it
      // will emit has been emitted) and all emitted frames are encoded.
      if (isExtractionFinished && decoderFlushed && pendingFrames === 0) {
        finishExport();
      }
    };

    const maybeFlushDecoder = () => {
      if (!isExtractionFinished || decoderFlushStarted || !videoDecoder || decodeQueue.length > 0) return;
      decoderFlushStarted = true;
      videoDecoder.flush()
        .then(() => {
          decoderFlushed = true;
          maybeFinishExport();
        })
        .catch(fail);
    };

    const pumpDecodeQueue = () => {
      if (!videoDecoder || !encoderConfigured || aborted || signal?.aborted || decoderFlushStarted) return;
      while (
        decodeQueue.length > 0 &&
        videoDecoder.decodeQueueSize < MAX_DECODE_QUEUE &&
        pendingFrames < maxPendingFrames &&
        (videoEncoder ? videoEncoder.encodeQueueSize < MAX_ENCODE_QUEUE : true)
      ) {
        const chunk = decodeQueue.shift();
        try {
          videoDecoder.decode(chunk);
        } catch (error) {
          fail(error);
          return;
        }
      }
      maybeFlushDecoder();
    };

    const configureEncoder = async (config, trackInfo, audioInfo, hasUnsupportedAudio) => {
      if (encoderConfigured) return;
      checkAbort();

      srcWidth = config.codedWidth ?? 0;
      srcHeight = config.codedHeight ?? 0;
      if (!srcWidth || !srcHeight) {
        throw new Error('Could not read video dimensions.');
      }
      // Output may be downscaled (e.g. 4K -> 1080p) so software H.264 encode
      // stays fast and memory bounded. Watermark removal still runs at source res.
      const fitted = fitWithin(srcWidth, srcHeight, maxOutputDimension);
      outputWidth = fitted.width;
      outputHeight = fitted.height;
      const downscaling = outputWidth !== srcWidth || outputHeight !== srcHeight;

      exportFps = normalizeFps(trackInfo.frameRate);
      keyFrameInterval = Math.max(1, Math.round(exportFps * 2));
      estimatedTotalFrames = trackInfo.frameCount > 0
        ? trackInfo.frameCount
        : Math.max(1, Math.round((trackInfo.durationSeconds ?? 1) * exportFps));
      box = getWatermarkConfig(srcWidth, srcHeight);
      // Memory cost is driven by the decoded (source) frame size.
      const bigFrame = srcWidth * srcHeight > 1920 * 1080;
      maxPendingFrames = bigFrame ? Math.max(workers.length, 6) : Math.max(workers.length * 3, 18);

      if (hasUnsupportedAudio) {
        unsupportedAudioWarning = 'Audio codec unsupported; exported video-only MP4.';
      }

      muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: {
          codec: 'avc',
          width: outputWidth,
          height: outputHeight,
          frameRate: exportFps
        },
        ...(audioInfo
          ? {
            audio: {
              codec: audioInfo.codec,
              numberOfChannels: audioInfo.numberOfChannels,
              sampleRate: audioInfo.sampleRate
            }
          }
          : {}),
        fastStart: 'in-memory',
        firstTimestampBehavior: audioInfo ? 'cross-track-offset' : 'offset'
      });

      const targetBitrate = chooseExportBitrate(outputWidth, outputHeight, trackInfo, exportFps);
      const baseCodec = chooseAvcCodec(outputWidth, outputHeight, exportFps);
      const encoderConfig = await pickSupportedVideoEncoderConfig(
        { width: outputWidth, height: outputHeight, framerate: exportFps },
        baseCodec,
        targetBitrate
      );
      checkAbort();
      console.log('[gwr-video] encoder:', `${srcWidth}x${srcHeight}->${outputWidth}x${outputHeight}`, encoderConfig.codec, encoderConfig.hardwareAcceleration, Math.round(encoderConfig.bitrate / 1e6) + 'Mbps');
      videoEncoder.configure(encoderConfig);

      // Composite (watermark removal) happens on a source-res canvas...
      drawCanvas = document.createElement('canvas');
      drawCanvas.width = srcWidth;
      drawCanvas.height = srcHeight;
      drawCtx = drawCanvas.getContext('2d');
      if (!drawCtx) throw new Error('Canvas 2D is not available.');
      // ...then, when downscaling, it's scaled down into the output-res canvas.
      if (downscaling) {
        scaleCanvas = document.createElement('canvas');
        scaleCanvas.width = outputWidth;
        scaleCanvas.height = outputHeight;
        scaleCtx = scaleCanvas.getContext('2d');
        if (scaleCtx) { scaleCtx.imageSmoothingEnabled = true; scaleCtx.imageSmoothingQuality = 'high'; }
      }

      encoderConfigured = true;
      onProgress({ progress: 0, currentFrame: 0, totalFrames: estimatedTotalFrames, speedFps: 0, warning: unsupportedAudioWarning });
    };

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxer?.addVideoChunk(chunk, meta);
        // Encoder drained a slot — resume decoding if we were backpressured.
        pumpDecodeQueue();
      },
      error: fail
    });

    const maxWorkers = Math.max(2, Math.min(MAX_VIDEO_WORKERS, navigator.hardwareConcurrency || 4));
    const workerUrl = new URL('./video-processor-worker.js', import.meta.url);
    workers.push(...Array.from({ length: maxWorkers }, () => new Worker(workerUrl, { type: 'module' })));

    workers.forEach((worker) => {
      worker.onmessage = (event) => {
        if (aborted || signal?.aborted) return;
        const { id, processedBox, error } = event.data;
        if (error) {
          pendingFrames--;
          fail(new Error(error));
          return;
        }

        const orderIndex = frameOrder.findIndex((frame) => frame.id === id);
        if (orderIndex !== -1) {
          frameOrder[orderIndex].processedBox = processedBox;
          frameOrder[orderIndex].done = true;
        }

        while (frameOrder.length > 0 && frameOrder[0].done) {
          const frame = frameOrder.shift();
          if (!frame || !videoEncoder || !drawCtx || !drawCanvas) continue;

          drawCtx.drawImage(frame.originalFrameBitmap, 0, 0);
          if (frame.processedBox) {
            drawCtx.drawImage(frame.processedBox, frame.x, frame.y);
          }

          let frameSource = drawCanvas;
          if (scaleCanvas && scaleCtx) {
            scaleCtx.drawImage(drawCanvas, 0, 0, scaleCanvas.width, scaleCanvas.height);
            frameSource = scaleCanvas;
          }

          const frameInit = { timestamp: frame.timestamp };
          if (typeof frame.duration === 'number') frameInit.duration = frame.duration;
          const outFrame = new VideoFrame(frameSource, frameInit);
          videoEncoder.encode(outFrame, { keyFrame: totalEncoded % keyFrameInterval === 0 });
          outFrame.close();
          totalEncoded += 1;

          const elapsedTime = (Date.now() - startedAt) / 1000;
          onProgress({
            progress: Math.min(100, Math.max(0, (totalEncoded / estimatedTotalFrames) * 100)),
            currentFrame: totalEncoded,
            totalFrames: estimatedTotalFrames,
            speedFps: elapsedTime > 0 ? totalEncoded / elapsedTime : exportFps,
            warning: unsupportedAudioWarning
          });

          frame.originalFrameBitmap.close?.();
          frame.processedBox?.close?.();
        }

        pendingFrames--;
        pumpDecodeQueue();
        maybeFinishExport();
      };
      worker.onerror = (error) => fail(new Error(error.message || 'Video worker failed.'));
    });

    videoDecoder = new VideoDecoder({
      output: async (frame) => {
        if (aborted || signal?.aborted) {
          frame.close?.();
          return;
        }
        decodeFinishedCount += 1;
        const id = frameCount++;
        const timestamp = frame.timestamp;
        const duration = frame.duration ?? undefined;
        pendingFrames += 1;

        let bitmapWorker = null;
        try {
          const bitmapMain = await createImageBitmap(frame);
          try {
            bitmapWorker = await createImageBitmap(frame, box.x, box.y, box.w, box.h);
          } catch (_) {
            // Older engines may not support VideoFrame crop in createImageBitmap.
            // Fallback still works, but it sends a full-frame bitmap to the worker.
            bitmapWorker = await createImageBitmap(frame);
          }

          frameOrder.push({
            id,
            timestamp,
            duration,
            done: false,
            originalFrameBitmap: bitmapMain,
            processedBox: null,
            x: box.x,
            y: box.y
          });
          frame.close();

          workers[workerIdx].postMessage({
            id,
            frameBitmap: bitmapWorker,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
            intensity: VIDEO_INTENSITY,
            outlineWidth: VIDEO_OUTLINE_WIDTH,
            inpaintRadius: VIDEO_INPAINT_RADIUS
          }, [bitmapWorker]);
          bitmapWorker = null;
          workerIdx = (workerIdx + 1) % workers.length;
          pumpDecodeQueue();
        } catch (error) {
          bitmapWorker?.close?.();
          frame.close?.();
          pendingFrames--;
          pumpDecodeQueue();
          fail(error);
        }
      },
      error: fail
    });

    extractFrames(
      file,
      async (config, trackInfo, audioInfo, hasUnsupportedAudio) => {
        try {
          if (videoDecoder) {
            const decoderConfig = await pickSupportedDecoderConfig(config);
            videoDecoder.configure(decoderConfig);
          }
          await configureEncoder(config, trackInfo, audioInfo, hasUnsupportedAudio);
          pumpDecodeQueue();
        } catch (error) {
          fail(error);
        }
      },
      (chunk) => {
        if (aborted || signal?.aborted) return;
        chunkCount += 1;
        decodeQueue.push(chunk);
        pumpDecodeQueue();
      },
      () => {
        isExtractionFinished = true;
        maybeFlushDecoder();
      },
      (audioChunk) => {
        muxer?.addAudioChunkRaw(audioChunk.data, audioChunk.type, audioChunk.timestamp, audioChunk.duration);
      }
    ).catch(fail);
  });
}
