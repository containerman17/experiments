// Voice input button.
// Records audio in the browser, streams it to Deepgram in real time,
// and types finalized phrases into the active tmux session from the frontend.

import { useState, useRef, useCallback, useEffect } from 'react';
import type { Connection } from '../ws';

interface Props {
  conn: Connection;
  session: string | null;
  isMobile: boolean;
}

interface VoiceState {
  recording: boolean;
  startedAt: number | null;
  micLabel: string;
  error: string | null;
}

const MIC_KEY = 'claudemux_mic';
const DEEPGRAM_API_KEY_KEY = 'claudemux_deepgram_api_key';
const DEEPGRAM_VOCAB_KEY = 'claudemux_deepgram_vocabulary';

const voiceStateListeners = new Set<(state: VoiceState) => void>();
let sharedVoiceState: VoiceState = {
  recording: false,
  startedAt: null,
  micLabel: '',
  error: null,
};
let sharedStream: MediaStream | null = null;
let sharedSocket: WebSocket | null = null;
let sharedAudioContext: AudioContext | null = null;
let sharedProcessor: ScriptProcessorNode | null = null;
let sharedTypedPreview = '';
let sharedTypedPreviewSession: string | null = null;

function setSharedVoiceState(next: Partial<VoiceState>): void {
  sharedVoiceState = { ...sharedVoiceState, ...next };
  for (const listener of voiceStateListeners) listener(sharedVoiceState);
}

function setVoiceError(message: string): void {
  console.error(`[voice] ${message}`);
  setSharedVoiceState({ error: message });
}

function getVocabularyTerms(): string[] {
  return (localStorage.getItem(DEEPGRAM_VOCAB_KEY) || '')
    .split(',')
    .map(term => term.trim())
    .filter(Boolean);
}

function float32ToInt16(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length);
  for (let index = 0; index < float32Array.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[index]));
    int16Array[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16Array;
}

function normalizeInterimTranscript(text: string): string {
  return text.replace(/\s+$/, '');
}

function normalizeFinalTranscript(text: string): string {
  const compact = text.replace(/\s+$/, '');
  if (!compact) return '';
  return /[\s([{/"'-]$/.test(compact) ? compact : `${compact} `;
}

function clearTypedPreview(conn: Connection): void {
  if (!sharedTypedPreview || !sharedTypedPreviewSession) return;
  conn.send({
    type: 'terminal.input',
    session: sharedTypedPreviewSession,
    data: '\x7f'.repeat(sharedTypedPreview.length),
  });
  sharedTypedPreview = '';
}

function replaceTypedPreview(conn: Connection, session: string, nextText: string): void {
  if (sharedTypedPreviewSession && sharedTypedPreviewSession !== session) {
    sharedTypedPreview = '';
  }
  sharedTypedPreviewSession = session;
  if (sharedTypedPreview) {
    conn.send({ type: 'terminal.input', session, data: '\x7f'.repeat(sharedTypedPreview.length) });
  }
  if (nextText) {
    conn.send({ type: 'terminal.input', session, data: nextText });
  }
  sharedTypedPreview = nextText;
}

function teardownRecording(): void {
  if (sharedProcessor) {
    sharedProcessor.disconnect();
    sharedProcessor.onaudioprocess = null;
    sharedProcessor = null;
  }
  if (sharedAudioContext) {
    void sharedAudioContext.close();
    sharedAudioContext = null;
  }
  if (sharedStream) {
    sharedStream.getTracks().forEach(track => track.stop());
    sharedStream = null;
  }
  if (sharedSocket) {
    sharedSocket.onopen = null;
    sharedSocket.onmessage = null;
    sharedSocket.onerror = null;
    sharedSocket.onclose = null;
    if (sharedSocket.readyState === WebSocket.OPEN || sharedSocket.readyState === WebSocket.CONNECTING) {
      sharedSocket.close();
    }
    sharedSocket = null;
  }
}

function stopAudioCapture(): void {
  if (sharedProcessor) {
    sharedProcessor.disconnect();
    sharedProcessor.onaudioprocess = null;
    sharedProcessor = null;
  }
  if (sharedAudioContext) {
    void sharedAudioContext.close();
    sharedAudioContext = null;
  }
  if (sharedStream) {
    sharedStream.getTracks().forEach(track => track.stop());
    sharedStream = null;
  }
}

export function VoiceButton({ conn, session, isMobile }: Props) {
  const [voiceState, setVoiceState] = useState<VoiceState>(sharedVoiceState);
  const [elapsed, setElapsed] = useState(0);
  const latestSessionRef = useRef(session);

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
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - voiceState.startedAt!) / 1000)), 1000);
    return () => clearInterval(id);
  }, [voiceState.recording, voiceState.startedAt]);

  const startRecording = useCallback(async () => {
    const apiKey = localStorage.getItem(DEEPGRAM_API_KEY_KEY)?.trim();

    setSharedVoiceState({ error: null });
    if (!apiKey) {
      setVoiceError('Set Deepgram API key in Settings');
      return;
    }

    try {
      const micId = localStorage.getItem(MIC_KEY);
      const audioConstraints: MediaTrackConstraints = micId ? { deviceId: { exact: micId } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      sharedStream = stream;
      setSharedVoiceState({ micLabel: stream.getAudioTracks()[0]?.label || '' });
      const params = new URLSearchParams({
        model: 'nova-3',
        language: 'en',
        smart_format: 'true',
        interim_results: 'true',
        endpointing: '300',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
      });
      for (const term of getVocabularyTerms()) params.append('keyterm', term);

      const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['token', apiKey]);
      sharedSocket = socket;

      socket.onopen = () => {
        const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) {
          setVoiceError('AudioContext unavailable');
          teardownRecording();
          setSharedVoiceState({ recording: false, startedAt: null });
          return;
        }

        sharedAudioContext = new AudioCtx({ sampleRate: 16000 });
        const source = sharedAudioContext.createMediaStreamSource(stream);
        const processor = sharedAudioContext.createScriptProcessor(4096, 1, 1);
        sharedProcessor = processor;
        processor.onaudioprocess = (event) => {
          if (!sharedSocket || sharedSocket.readyState !== WebSocket.OPEN) return;
          const inputData = event.inputBuffer.getChannelData(0);
          const int16 = float32ToInt16(inputData);
          sharedSocket.send(int16.buffer);
        };
        source.connect(processor);
        processor.connect(sharedAudioContext.destination);
        setSharedVoiceState({ recording: true, startedAt: Date.now(), error: null });
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            type?: string;
            is_final?: boolean;
            channel?: { alternatives?: Array<{ transcript?: string }> };
          };
          if (data.type !== 'Results') return;
          const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
          if (!transcript) return;

          const currentSession = latestSessionRef.current;
          if (!currentSession) return;

          if (data.is_final) {
            const finalTranscript = normalizeFinalTranscript(transcript);
            if (!finalTranscript) return;
            replaceTypedPreview(conn, currentSession, finalTranscript);
            sharedTypedPreview = '';
          } else {
            const interimTranscript = normalizeInterimTranscript(transcript);
            replaceTypedPreview(conn, currentSession, interimTranscript);
          }
        } catch {
          setVoiceError('Deepgram response parse error');
        }
      };

      socket.onerror = () => {
        setVoiceError('Deepgram connection failed');
        sharedTypedPreview = '';
        sharedTypedPreviewSession = null;
        teardownRecording();
        setSharedVoiceState({ recording: false, startedAt: null });
      };

      socket.onclose = (event) => {
        if (!event.wasClean) {
          setVoiceError(`Deepgram closed: ${event.code}${event.reason ? ` ${event.reason}` : ''}`);
        }
        sharedTypedPreviewSession = null;
        teardownRecording();
        setSharedVoiceState({ recording: false, startedAt: null });
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mic access denied';
      setVoiceError(`Mic error: ${message}`);
      teardownRecording();
    }
  }, [conn]);

  const stopRecording = useCallback(() => {
    stopAudioCapture();
    setSharedVoiceState({ recording: false, startedAt: null });

    const socket = sharedSocket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'CloseStream' }));
      socket.close();
      return;
    }

    sharedTypedPreviewSession = null;
    teardownRecording();
  }, []);

  return (
    <div className="flex items-center gap-1 min-w-0">
      <button
        onClick={voiceState.recording ? stopRecording : startRecording}
        className={isMobile
          ? `w-12 h-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${voiceState.recording ? 'bg-red-500 hover:bg-red-600 animate-pulse' : 'bg-zinc-700 hover:bg-zinc-600'}`
          : `w-9 h-9 border flex items-center justify-center transition-colors cursor-pointer ${voiceState.recording ? 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20' : 'border-zinc-700 bg-transparent hover:bg-zinc-900 text-zinc-300'}`}
        title={voiceState.recording ? `Stop transcription${voiceState.micLabel ? ` (${voiceState.micLabel})` : ''}` : 'Start transcription'}
      >
        {voiceState.recording ? (
          <svg viewBox="0 0 24 24" fill="currentColor" className={isMobile ? 'w-5 h-5' : 'w-4 h-4'}>
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isMobile ? 'w-6 h-6' : 'w-4 h-4'}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
      </button>
      {voiceState.recording && !isMobile && (
        <span className="text-[10px] text-zinc-500 truncate max-w-[120px]">
          {Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, '0')}
        </span>
      )}
      {voiceState.error && <span className="text-red-400 text-xs max-w-[180px] truncate">{voiceState.error}</span>}
    </div>
  );
}
