// Global recording bar shown above tab content when recording is active.
// Visible across all tabs (agent + terminal) so recording persists on tab switch.

import { useState, useEffect, useRef } from 'react';
import { useRecording } from './RecordingContext';

function AudioVisualizer({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    // Support high-DPI (Retina) displays
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    
    // Set actual canvas size (resolution) based on DPR
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Scale context so drawing operations use CSS pixels
    ctx.scale(dpr, dpr);

    // CSS dimensions for drawing calculations
    const w = rect.width;
    const h = rect.height;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, w, h);

      const numBars = 5;
      const barWidth = 3;
      const gap = 2;
      const startX = (w - (numBars * barWidth + (numBars - 1) * gap)) / 2;

      for (let i = 0; i < numBars; i++) {
        // Create a fake "symmetric" wave by grouping frequency data.
        // Even though lower frequencies are louder, we can artificially map the data
        // so the middle bar gets the most energy, and outer bars get less.
        // We'll read from bins 2 through 6.
        const binIndex = 2 + i;
        const rawValue = dataArray[binIndex] || 0; // 0-255
        
        // Artificial symmetric weighting (0.5, 0.8, 1.0, 0.8, 0.5)
        const weights = [0.5, 0.8, 1.0, 0.8, 0.5];
        const weightedValue = rawValue * weights[i];
        
        // Exponentiate to make it more dynamic (quiet parts stay quiet, loud parts pop)
        const percent = Math.pow(weightedValue / 255, 1.5); 
        const barHeight = Math.max(3, percent * h); 
        
        const x = startX + i * (barWidth + gap);
        const y = (h - barHeight) / 2; // vertically centered

        ctx.fillStyle = '#ef4444'; // red-500
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        ctx.fill();
      }
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [analyser]);

  return <canvas ref={canvasRef} className="w-6 h-6 shrink-0 block" />;
}

export function RecordingBar({ activeAgentId }: { activeAgentId: string | null | undefined }) {
  const { recording, transcribing, cancelRecording, stopRecording, audioError, clearAudioError, analyser } = useRecording();
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
    <div className="shrink-0 w-full bg-zinc-800 border-t border-zinc-700 px-4 py-4 flex items-center gap-4 text-sm transition-all duration-300 animate-slide-up">
      {recording && (
        <>
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-red-500/20 shrink-0">
            {analyser ? (
              <AudioVisualizer analyser={analyser} />
            ) : (
              <span className="w-3.5 h-3.5 rounded-full bg-red-500 animate-pulse" />
            )}
          </div>
          <div className="flex flex-col min-w-[4rem] justify-center flex-1">
            <span className="text-zinc-100 font-medium text-xs uppercase tracking-wider leading-none mb-1.5">Recording</span>
            <span className="text-zinc-400 font-mono text-sm leading-none">{mm}:{ss}</span>
          </div>
          <div className="w-px h-8 bg-zinc-700 mx-1 shrink-0" />
          <button
            onClick={cancelRecording}
            className="p-3 rounded-full hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
            title="Cancel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
          <button
            onClick={() => activeAgentId ? stopRecording(activeAgentId) : cancelRecording()}
            disabled={!activeAgentId}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-zinc-200 hover:bg-white text-zinc-900 font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>
            Send
          </button>
        </>
      )}
      {transcribing && (
        <>
          <div className="flex items-center justify-center w-10 h-10 shrink-0">
            <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current text-blue-400 animate-spin">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z" opacity="0.25"/>
              <path d="M12 2a10 10 0 019.95 9h-2.01A8 8 0 0012 4V2z"/>
            </svg>
          </div>
          <span className="text-zinc-200 text-base font-medium pr-3 pl-1">Transcribing...</span>
        </>
      )}
      {audioError && !recording && !transcribing && (
        <>
          <div className="flex items-center justify-center w-10 h-10 shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6 text-red-400">
              <circle cx="12" cy="12" r="10"/>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01"/>
            </svg>
          </div>
          <span className="text-red-300 text-base flex-1 truncate pr-2">{audioError}</span>
          <button onClick={clearAudioError} className="p-3 hover:bg-zinc-700 rounded-full text-red-400 hover:text-red-300 shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </>
      )}
    </div>
  );
}
