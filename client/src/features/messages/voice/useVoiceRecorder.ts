// The message box's recorder (voice-recorder.ts) as a hook, with the live waveform (Pass A, 15 May) drawn from the
// microphone while it records. The recorder is made when the box mounts and disposed when it unmounts: a take running
// then is handed to the box's own onRecorded, which keeps it in the conversation it was recorded in.

import { useEffect, useRef, useState } from 'react';
import {
  createVoiceRecorder, type MediaRecorderLike, type RecorderDeps, type RecorderState, type TakeEnd, type VoiceRecorder,
} from './voice-recorder';

interface Handlers {
  onRecorded: (blob: Blob, durationMs: number, how: TakeEnd) => void;
  onError: (sentence: string) => void;
}

type AudioContextCtor = typeof AudioContext;

function browserRecorderDeps(): RecorderDeps<MediaStream> {
  return {
    supported: () => typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia,
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    createRecorder: (stream) => {
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const r = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const like: MediaRecorderLike = {
        get state() { return r.state; },
        get mimeType() { return r.mimeType; },
        ondataavailable: null,
        onstop: null,
        start: () => r.start(),
        stop: () => r.stop(),
        requestData: () => r.requestData(),
      };
      r.ondataavailable = (e) => like.ondataavailable?.({ data: e.data });
      r.onstop = () => like.onstop?.();
      return like;
    },
    now: () => Date.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    setTimeout: (fn, ms) => { window.setTimeout(fn, ms); },
  };
}

function drawWaveform(canvas: HTMLCanvasElement, analyser: AnalyserNode): void {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const c = canvas.getContext('2d');
  if (!c) return;
  const { width: w, height: h } = canvas;
  c.clearRect(0, 0, w, h);
  const bars = 40;
  const stride = Math.floor(data.length / bars);
  const barW = w / bars;
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < stride; j++) sum += data[i * stride + j] || 0;
    const barH = Math.max(2, (sum / stride / 255) * h * 0.9);
    c.fillStyle = '#e10600';
    c.fillRect(i * barW + barW * 0.15, (h - barH) / 2, barW * 0.7, barH);
  }
}

export function useVoiceRecorder(handlers: Handlers) {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stopWaveformRef = useRef<() => void>(() => {});

  const startWaveform = (stream: MediaStream) => {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      ctx.createMediaStreamSource(stream).connect(analyser);
      let raf = 0;
      const frame = () => {
        if (canvasRef.current) drawWaveform(canvasRef.current, analyser);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      stopWaveformRef.current = () => {
        cancelAnimationFrame(raf);
        try { analyser.disconnect(); } catch { /* already disconnected */ }
        if (ctx.state !== 'closed') ctx.close().catch(() => { /* closing a finished context can reject; nothing to undo */ });
        stopWaveformRef.current = () => {};
      };
    } catch {
      // The waveform is decoration: a browser that blocks Web Audio still records.
    }
  };

  useEffect(() => {
    const recorder = createVoiceRecorder(browserRecorderDeps(), {
      onState: setState,
      onTick: setElapsedMs,
      onRecorded: (blob, durationMs, how) => handlersRef.current.onRecorded(blob, durationMs, how),
      onError: (sentence) => handlersRef.current.onError(sentence),
      onStream: (stream) => {
        stopWaveformRef.current();
        if (stream) startWaveform(stream);
      },
    });
    recorderRef.current = recorder;
    return () => {
      recorder.dispose();
      stopWaveformRef.current();
      recorderRef.current = null;
    };
  }, []);

  return {
    state,
    elapsedMs,
    canvasRef,
    start: () => { void recorderRef.current?.start(); },
    stop: () => recorderRef.current?.stop(),
    cancel: () => recorderRef.current?.cancel(),
  };
}
