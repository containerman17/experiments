// Global voice recording context.
// Lives in WorkspacePage so recording persists across tab switches.
// The recording bar is rendered by WorkspacePage when active.

import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useConnection } from '../App';
import { useAppState, useDispatch } from '../store';
import { sessionPromptRequest } from '../acp';

interface RecordingState {
  recording: boolean;
  transcribing: boolean;
  audioError: string | null;
  /** Agent ID that will receive the transcription */
  targetAgentId: string | null;
  analyser: AnalyserNode | null;
  startRecording: () => void;
  stopRecording: (agentId: string) => void;
  cancelRecording: () => void;
  clearAudioError: () => void;
}

const RecordingCtx = createContext<RecordingState>(null!);
export const useRecording = () => useContext(RecordingCtx);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [recording, setRecording] = useState(false);
  const [transcribingCount, setTranscribingCount] = useState(0);
  const transcribing = transcribingCount > 0;
  const [audioError, setAudioError] = useState<string | null>(null);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const cancelledRef = useRef(false);
  const conn = useConnection();
  const state = useAppState();
  const dispatch = useDispatch();
  const transcribingCountRef = useRef(0);
  transcribingCountRef.current = transcribingCount;
  const targetAgentIdRef = useRef<string | null>(null);
  targetAgentIdRef.current = targetAgentId;

  const startRecording = useCallback(async () => {
    setAudioError(null);
    cancelledRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 64;
      source.connect(analyserNode);
      audioContextRef.current = audioCtx;
      setAnalyser(analyserNode);

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (audioContextRef.current?.state !== 'closed') {
          audioContextRef.current?.close().catch(() => {});
        }
        setAnalyser(null);
        if (cancelledRef.current) return; // discard
        const agentId = targetAgentIdRef.current;
        if (!agentId) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          setTranscribingCount(c => c + 1);
          conn.send({ type: 'agent.audio', agentId, data: base64, mimeType: recorder.mimeType });
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [conn]);

  const stopRecording = useCallback((agentId: string) => {
    setTargetAgentId(agentId);
    targetAgentIdRef.current = agentId;
    cancelledRef.current = false;
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }, []);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }, []);

  // Listen for transcription results
  useEffect(() => {
    return conn.subscribe((msg: any) => {
      if (msg.type === 'agent.audio.transcription') {
        setTranscribingCount(c => Math.max(0, c - 1));
        setAudioError(null);
        const agentId = msg.agentId;
        const agent = state.agents[agentId];
        if (msg.text && agent?.acpSessionId) {
          conn.send({
            type: 'agent.message',
            agentId,
            payload: sessionPromptRequest(agent.acpSessionId, msg.text),
          });
          dispatch({ type: 'AGENT_BUSY', agentId, busy: true });
        }
      }
      if (msg.type === 'error' && transcribingCountRef.current > 0) {
        setTranscribingCount(c => Math.max(0, c - 1));
        setAudioError(msg.message);
      }
    });
  }, [conn, dispatch, state.agents]);

  return (
    <RecordingCtx.Provider value={{
      recording, transcribing, audioError, targetAgentId, analyser,
      startRecording, stopRecording, cancelRecording,
      clearAudioError: () => setAudioError(null),
    }}>
      {children}
    </RecordingCtx.Provider>
  );
}
