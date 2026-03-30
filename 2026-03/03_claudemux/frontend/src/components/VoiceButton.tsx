// Voice input button.
// Records audio via MediaRecorder, then sends directly to Gemini API
// for transcription with terminal context. Falls back to backend if no API key set.

import { useState, useRef, useCallback, useEffect } from 'react';
import type { Connection } from '../ws';

interface Props {
  conn: Connection;
  session: string | null;
  isMobile: boolean;
  getContext?: () => string;
}

interface VoiceState {
  recording: boolean;
  sending: boolean;
  startedAt: number | null;
  micLabel: string;
  error: string | null;
  audioLevel: number;
  lastResult: { text: string; session: string } | null;
}

const MIC_KEY = 'claudemux_mic';
const AUTO_SEND_KEY = 'claudemux_voice_auto_send';
const GEMINI_KEY_STORAGE = 'claudemux_gemini_key';
const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_TIMEOUT = 20_000;
const GEMINI_MAX_RETRIES = 3;

export function getGeminiKey(): string {
  return localStorage.getItem(GEMINI_KEY_STORAGE) || '';
}

export function setGeminiKey(key: string): void {
  localStorage.setItem(GEMINI_KEY_STORAGE, key);
}

async function callGeminiDirect(
  apiKey: string,
  audioBase64: string,
  mimeType: string,
  context: string,
): Promise<string> {
  const contextHint = context
    ? `\n\nRecent terminal output for context (use this to disambiguate technical terms):\n${context}`
    : '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      console.log(`[voice-frontend] calling Gemini (${GEMINI_MODEL}), attempt ${attempt}/${GEMINI_MAX_RETRIES}...`);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(GEMINI_TIMEOUT),
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: 'You are a transcription service for a software engineering terminal session. The speaker is dictating commands, code, or discussing technical topics. Preserve technical terms, function names, variable names, CLI commands, and programming jargon accurately. Output ONLY the transcription, nothing else.' }],
          },
          generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
          contents: [{
            parts: [
              { text: `Transcribe this voice message:${contextHint}` },
              { inlineData: { mimeType, data: audioBase64 } },
            ],
          }],
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini API error ${resp.status}: ${errText}`);
      }
      const json = await resp.json() as any;
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(empty transcription)';
      console.log(`[voice-frontend] transcribed: ${text}`);
      return text;
    } catch (err: any) {
      lastErr = err;
      console.error(`[voice-frontend] attempt ${attempt} failed:`, err.message || err);
      if (attempt < GEMINI_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastErr!;
}

const voiceStateListeners = new Set<(state: VoiceState) => void>();
let sharedVoiceState: VoiceState = {
  recording: false,
  sending: false,
  startedAt: null,
  micLabel: '',
  error: null,
  audioLevel: 0,
  lastResult: null,
};
let sendingTimeout: ReturnType<typeof setTimeout> | null = null;
let sharedStream: MediaStream | null = null;
let sharedRecorder: MediaRecorder | null = null;
let sharedAnalyser: AnalyserNode | null = null;
let sharedAudioCtx: AudioContext | null = null;
let sharedLevelRaf: number | null = null;

function setSharedVoiceState(next: Partial<VoiceState>): void {
  sharedVoiceState = { ...sharedVoiceState, ...next };
  for (const listener of voiceStateListeners) listener(sharedVoiceState);
}

function setVoiceError(message: string): void {
  console.error(`[voice] ${message}`);
  setSharedVoiceState({ error: message });
}

function teardownRecording(): void {
  if (sharedLevelRaf !== null) {
    cancelAnimationFrame(sharedLevelRaf);
    sharedLevelRaf = null;
  }
  if (sharedRecorder) {
    if (sharedRecorder.state !== 'inactive') {
      try { sharedRecorder.stop(); } catch { /* ignore */ }
    }
    sharedRecorder = null;
  }
  if (sharedStream) {
    sharedStream.getTracks().forEach(track => track.stop());
    sharedStream = null;
  }
  if (sharedAudioCtx) {
    sharedAudioCtx.close().catch(() => {});
    sharedAudioCtx = null;
    sharedAnalyser = null;
  }
}

// Real audio level metering via AnalyserNode
function setupAudioLevelMeter(stream: MediaStream): void {
  try {
    const ctx = new AudioContext();
    sharedAudioCtx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    sharedAnalyser = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!sharedAnalyser) return;
      sharedAnalyser.getByteFrequencyData(dataArray);
      // RMS-ish level from frequency data, normalized to 0-1
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length / 255;
      // Boost low values for visual responsiveness
      const level = Math.min(1, avg * 3);
      setSharedVoiceState({ audioLevel: level });
      sharedLevelRaf = requestAnimationFrame(tick);
    };
    sharedLevelRaf = requestAnimationFrame(tick);
  } catch {
    // Fallback: no metering, just a static level
    setSharedVoiceState({ audioLevel: 0.3 });
  }
}

// Release mic on page hide/unload so Safari PWA doesn't corrupt the audio session.
if (typeof window !== 'undefined') {
  const releaseOnHide = () => {
    if (sharedStream) teardownRecording();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseOnHide();
  });
  window.addEventListener('pagehide', releaseOnHide);
  window.addEventListener('beforeunload', releaseOnHide);
}

export function getAutoSend(): boolean {
  return localStorage.getItem(AUTO_SEND_KEY) !== 'false';
}

export function setAutoSend(value: boolean): void {
  localStorage.setItem(AUTO_SEND_KEY, value ? 'true' : 'false');
}

/** Called by App when voice.result arrives from the server. */
export function onVoiceResult(text: string, session: string): void {
  if (sendingTimeout) { clearTimeout(sendingTimeout); sendingTimeout = null; }
  setSharedVoiceState({ sending: false, lastResult: { text, session } });
}

/** Called by App when voice.error arrives from the server. */
export function onVoiceError(): void {
  if (sendingTimeout) { clearTimeout(sendingTimeout); sendingTimeout = null; }
  setSharedVoiceState({ sending: false });
}

/** Clear the last result (e.g. after re-inserting). */
export function clearLastResult(): void {
  setSharedVoiceState({ lastResult: null });
}

/** Get current shared voice state (for reading lastResult outside VoiceButton). */
export function getVoiceState(): VoiceState {
  return sharedVoiceState;
}

/** Subscribe to voice state changes. Returns unsubscribe function. */
export function subscribeVoiceState(fn: (state: VoiceState) => void): () => void {
  voiceStateListeners.add(fn);
  return () => { voiceStateListeners.delete(fn); };
}

export function VoiceButton({ conn, session, isMobile, getContext }: Props) {
  const [voiceState, setVoiceState] = useState<VoiceState>(sharedVoiceState);
  const [elapsed, setElapsed] = useState(0);
  const latestSessionRef = useRef(session);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('');

  useEffect(() => {
    latestSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const listener = (state: VoiceState) => setVoiceState(state);
    voiceStateListeners.add(listener);
    listener(sharedVoiceState);
    return () => { voiceStateListeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (!voiceState.recording || !voiceState.startedAt) { setElapsed(0); return; }
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - voiceState.startedAt!) / 1000)), 100);
    return () => clearInterval(id);
  }, [voiceState.recording, voiceState.startedAt]);

  const startRecording = useCallback(async () => {
    if (!getGeminiKey()) {
      setVoiceError('Set Gemini API key in Settings');
      return;
    }
    setSharedVoiceState({ error: null });
    chunksRef.current = [];

    try {
      const micId = localStorage.getItem(MIC_KEY);
      const audioConstraints: MediaTrackConstraints = micId ? { deviceId: { exact: micId } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      sharedStream = stream;

      // Safari iPad PWA can return a dead stream
      if (!stream.active || stream.getAudioTracks()[0]?.readyState !== 'live') {
        setVoiceError('Mic stream dead — clear site data in Safari settings and re-add PWA');
        teardownRecording();
        return;
      }

      setSharedVoiceState({ micLabel: stream.getAudioTracks()[0]?.label || '' });

      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
      const mime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m));
      if (!mime) {
        setVoiceError('No supported audio encoding');
        teardownRecording();
        return;
      }
      mimeRef.current = mime;

      const recorder = new MediaRecorder(stream, { mimeType: mime });
      sharedRecorder = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.start(250);
      setupAudioLevelMeter(stream);
      setSharedVoiceState({ recording: true, startedAt: Date.now(), error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mic access denied';
      setVoiceError(`Mic error: ${message}`);
      teardownRecording();
    }
  }, []);

  const getContextRef = useRef(getContext);
  useEffect(() => { getContextRef.current = getContext; }, [getContext]);

  const stopRecording = useCallback(() => {
    // Capture target session and context RIGHT NOW (at stop time)
    const targetSession = latestSessionRef.current;
    const targetContext = getContextRef.current?.() || '';
    const geminiKey = getGeminiKey();

    if (!targetSession) {
      setVoiceError('No active session');
      teardownRecording();
      setSharedVoiceState({ recording: false, startedAt: null, audioLevel: 0 });
      return;
    }

    if (sharedRecorder && sharedRecorder.state !== 'inactive') {
      sharedRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        chunksRef.current = [];
        teardownRecording();

        if (blob.size < 100) {
          setSharedVoiceState({ recording: false, sending: false, startedAt: null, audioLevel: 0 });
          return;
        }

        setSharedVoiceState({ recording: false, sending: true, startedAt: null, audioLevel: 0 });

        try {
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);

          // Direct Gemini API call from browser
          try {
            const text = await callGeminiDirect(geminiKey, base64, mimeRef.current, targetContext);
            // Paste into the target session (captured at stop time)
            conn.send({ type: 'terminal.input', session: targetSession, data: text });
            if (getAutoSend()) {
              setTimeout(() => {
                conn.send({ type: 'terminal.input', session: targetSession, data: '\r' });
              }, 150);
            }
            onVoiceResult(text, targetSession);
          } catch (err) {
            setVoiceError(`Transcription failed: ${err instanceof Error ? err.message : err}`);
            setSharedVoiceState({ sending: false });
          }
        } catch (err) {
          setVoiceError(`Failed to encode audio: ${err instanceof Error ? err.message : err}`);
          setSharedVoiceState({ sending: false });
        }
      };
      sharedRecorder.stop();
    } else {
      teardownRecording();
      setSharedVoiceState({ recording: false, sending: false, startedAt: null, audioLevel: 0 });
    }
  }, [conn]);

  const cancelRecording = useCallback(() => {
    chunksRef.current = [];
    teardownRecording();
    setSharedVoiceState({ recording: false, sending: false, startedAt: null, audioLevel: 0, error: null });
  }, []);

  const { recording, sending, audioLevel, error } = voiceState;

  // Record button opacity pulses with voice level
  const recordOpacity = recording ? 0.5 + audioLevel * 0.5 : 1;

  const timerText = `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {recording ? (
        <>
          {/* Big red button with timer inside — tap to send */}
          <button
            onClick={stopRecording}
            style={{ opacity: recordOpacity }}
            className={isMobile
              ? 'h-12 px-4 rounded-full flex items-center justify-center transition-colors cursor-pointer bg-red-500 hover:bg-red-600 text-white'
              : 'h-9 px-3 border flex items-center justify-center transition-colors cursor-pointer border-red-500/40 bg-red-500/20 text-red-300 hover:bg-red-500/30'}
            title={`Stop and send${voiceState.micLabel ? ` (${voiceState.micLabel})` : ''}`}
          >
            <span className={`tabular-nums font-mono ${isMobile ? 'text-sm font-medium' : 'text-xs'}`}>
              {timerText}
            </span>
          </button>
          {/* Cancel button */}
          <button
            onClick={cancelRecording}
            className={isMobile
              ? 'w-12 h-12 rounded-full flex items-center justify-center cursor-pointer bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
              : 'w-9 h-9 border flex items-center justify-center cursor-pointer border-zinc-700 bg-transparent hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200'}
            title="Cancel recording"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isMobile ? 'w-5 h-5' : 'w-4 h-4'}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </>
      ) : (
        // Idle / sending state: mic button
        <button
          onClick={startRecording}
          disabled={sending}
          className={isMobile
            ? `w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${sending ? 'bg-yellow-600 animate-pulse' : !getGeminiKey() ? 'bg-zinc-800 text-zinc-600' : 'bg-zinc-700 hover:bg-zinc-600'}`
            : `w-9 h-9 border flex items-center justify-center transition-colors cursor-pointer ${sending ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300 animate-pulse' : !getGeminiKey() ? 'border-zinc-800 bg-transparent text-zinc-700' : 'border-zinc-700 bg-transparent hover:bg-zinc-900 text-zinc-300'}`}
          title={sending ? 'Transcribing...' : !getGeminiKey() ? 'Set Gemini API key in Settings' : 'Start recording'}
        >
          {sending ? (
            <span className={`${isMobile ? 'text-xs' : 'text-[10px]'}`}>...</span>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isMobile ? 'w-6 h-6' : 'w-4 h-4'}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </button>
      )}

      {error && <span className="text-red-400 text-xs">{error}</span>}
    </div>
  );
}
