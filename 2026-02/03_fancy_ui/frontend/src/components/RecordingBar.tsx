// Global recording bar shown above tab content when recording is active.
// Visible across all tabs (agent + terminal) so recording persists on tab switch.

import { useState, useEffect, useRef } from 'react';
import { useRecording } from './RecordingContext';

export function RecordingBar({ activeAgentId }: { activeAgentId: string | null | undefined }) {
  const { recording, transcribing, cancelRecording, stopRecording, audioError, clearAudioError } = useRecording();
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(0);

  useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    startTime.current = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startTime.current) / 1000)), 200);
    return () => {
      clearInterval(iv);
      setElapsed(0);
    };
  }, [recording]);

  if (!recording && !transcribing && !audioError) return null;

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="absolute top-4 left-1/2 z-50 flex items-center gap-3 px-3 py-2 bg-zinc-800/95 backdrop-blur-md border border-zinc-700/80 rounded-full shadow-2xl text-sm transition-all duration-300 animate-slide-down">
      {recording && (
        <>
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-red-500/20 shrink-0">
            <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
          </div>
          <div className="flex flex-col min-w-[3.5rem] justify-center">
            <span className="text-zinc-100 font-medium text-[11px] uppercase tracking-wider leading-none mb-1">Recording</span>
            <span className="text-zinc-400 font-mono text-[11px] leading-none">{mm}:{ss}</span>
          </div>
          <div className="w-px h-6 bg-zinc-700 mx-1 shrink-0" />
          <button
            onClick={cancelRecording}
            className="p-1.5 rounded-full hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
            title="Cancel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
          <button
            onClick={() => activeAgentId ? stopRecording(activeAgentId) : cancelRecording()}
            disabled={!activeAgentId}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-red-600 hover:bg-red-500 text-white font-medium text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            Send
          </button>
        </>
      )}
      {transcribing && (
        <>
          <div className="flex items-center justify-center w-8 h-8 shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current text-blue-400 animate-spin">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z" opacity="0.25"/>
              <path d="M12 2a10 10 0 019.95 9h-2.01A8 8 0 0012 4V2z"/>
            </svg>
          </div>
          <span className="text-zinc-200 text-sm font-medium pr-3 pl-1">Transcribing...</span>
        </>
      )}
      {audioError && !recording && !transcribing && (
        <>
          <div className="flex items-center justify-center w-8 h-8 shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-red-400">
              <circle cx="12" cy="12" r="10"/>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01"/>
            </svg>
          </div>
          <span className="text-red-300 text-sm max-w-[200px] truncate pr-2">{audioError}</span>
          <button onClick={clearAudioError} className="p-1.5 hover:bg-zinc-700 rounded-full text-red-400 hover:text-red-300 shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </>
      )}
    </div>
  );
}
