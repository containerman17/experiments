// Voice input button.
// Records audio, sends it + session name to server.
// Server handles context extraction from ring buffer and Gemini transcription.

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

const voiceStateListeners = new Set<(state: VoiceState) => void>();
let sharedVoiceState: VoiceState = {
  recording: false,
  startedAt: null,
  micLabel: '',
  error: null,
};
let sharedRecorder: MediaRecorder | null = null;
let sharedStream: MediaStream | null = null;

function setSharedVoiceState(next: Partial<VoiceState>): void {
  sharedVoiceState = { ...sharedVoiceState, ...next };
  for (const listener of voiceStateListeners) listener(sharedVoiceState);
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
    setSharedVoiceState({ error: null });
    try {
      const micId = localStorage.getItem('claudemux_mic');
      const audioConstraints: MediaTrackConstraints = micId ? { deviceId: { exact: micId } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      sharedStream = stream;
      setSharedVoiceState({ micLabel: stream.getAudioTracks()[0]?.label || '' });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        sharedRecorder = null;
        sharedStream = null;
        setSharedVoiceState({ recording: false, startedAt: null });
        if (!latestSessionRef.current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          conn.send({ type: 'voice.transcribe', session: latestSessionRef.current!, audio: base64, mimeType: recorder.mimeType });
        };
        reader.readAsDataURL(blob);
      };

      sharedRecorder = recorder;
      recorder.start();
      setSharedVoiceState({ recording: true, startedAt: Date.now() });
    } catch {
      setSharedVoiceState({ error: 'Mic access denied' });
    }
  }, [conn]);

  const stopRecording = useCallback(() => {
    if (sharedRecorder?.state === 'recording') {
      sharedRecorder.stop();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    if (sharedRecorder) {
      sharedRecorder.ondataavailable = null;
      sharedRecorder.onstop = null;
      if (sharedRecorder.state === 'recording') sharedRecorder.stop();
      sharedRecorder = null;
    }
    sharedStream?.getTracks().forEach(t => t.stop());
    sharedStream = null;
    setSharedVoiceState({ recording: false, startedAt: null });
  }, []);

  if (voiceState.recording) {
    return (
      <div className={isMobile ? 'flex items-center gap-1' : 'flex flex-col items-start gap-1 w-full'}>
        <div className={`flex items-center ${isMobile ? 'gap-1' : 'w-full justify-between gap-3'}`}>
          {!isMobile && (
            <div className="flex items-center gap-2 min-w-0 text-zinc-300">
              <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />
              <span className="text-xs font-mono text-zinc-200">
                {Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, '0')}
              </span>
            </div>
          )}
          <button
            onClick={cancelRecording}
            className={isMobile ? 'toolbar-btn text-zinc-400 cursor-pointer' : 'text-blue-400 hover:text-blue-300 transition-colors cursor-pointer text-sm'}
            title="Cancel recording"
          >
            {isMobile ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              'Cancel'
            )}
          </button>
          <button
            onClick={stopRecording}
            className={isMobile
              ? 'h-12 px-4 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center gap-2 animate-pulse cursor-pointer'
              : 'h-8 px-3 border border-blue-500/40 bg-transparent text-blue-300 hover:bg-blue-500/10 flex items-center justify-center transition-colors cursor-pointer shrink-0'}
            title="Send recording"
          >
            {isMobile ? (
              <>
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 shrink-0">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
                <span className="text-xs font-mono text-white">{Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, '0')}</span>
              </>
            ) : (
              <span className="text-[11px] uppercase tracking-wide text-blue-200">Send</span>
            )}
          </button>
        </div>
        {voiceState.micLabel && (
          <span className={isMobile ? 'text-[10px] text-zinc-500 truncate max-w-[100px]' : 'text-[10px] text-zinc-600 truncate w-full'}>
            {voiceState.micLabel}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={startRecording}
        className={isMobile
          ? 'w-12 h-12 rounded-full bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center transition-colors cursor-pointer'
          : 'w-9 h-9 border border-zinc-700 bg-transparent hover:bg-zinc-900 text-zinc-300 flex items-center justify-center transition-colors cursor-pointer'}
        title="Voice input"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isMobile ? 'w-6 h-6' : 'w-4 h-4'}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
      {voiceState.error && <span className="text-red-400 text-xs">{voiceState.error}</span>}
    </div>
  );
}
