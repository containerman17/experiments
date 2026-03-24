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

export function VoiceButton({ conn, session, isMobile }: Props) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micLabel, setMicLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const micId = localStorage.getItem('claudemux_mic');
      const audioConstraints: MediaTrackConstraints = micId ? { deviceId: { exact: micId } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;
      setMicLabel(stream.getAudioTracks()[0]?.label || '');
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (!session) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          conn.send({ type: 'voice.transcribe', session, audio: base64, mimeType: recorder.mimeType });
        };
        reader.readAsDataURL(blob);
      };

      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setError('Mic access denied');
    }
  }, [conn, session]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    }
    setRecording(false);
  }, []);

  const cancelRecording = useCallback(() => {
    if (recorderRef.current) {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      if (recorderRef.current.state === 'recording') recorderRef.current.stop();
      recorderRef.current = null;
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    setRecording(false);
  }, []);

  if (recording) {
    return (
      <div className="flex items-center gap-1">
        <button onClick={cancelRecording} className="toolbar-btn text-zinc-400" title="Cancel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          onClick={stopRecording}
          className={`${isMobile ? 'h-12 px-4' : 'h-8 px-3'} rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center gap-2 animate-pulse`}
          title="Stop & Send"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 shrink-0">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span className="text-xs font-mono text-white">{Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, '0')}</span>
        </button>
        {micLabel && <span className="text-[10px] text-zinc-500 truncate max-w-[100px]">{micLabel}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={startRecording}
        className={`${isMobile ? 'w-12 h-12' : 'w-8 h-8'} rounded-full bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center transition-colors`}
        title="Voice input"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isMobile ? 'w-6 h-6' : 'w-4 h-4'}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
      {error && <span className="text-red-400 text-xs">{error}</span>}
    </div>
  );
}
