// xterm.js terminal connected to a tmux session via WebSocket.
// Attaches on mount, replays ring buffer, streams output.
// Does NOT close the tmux session on unmount — sessions are persistent.

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { Connection } from '../ws';

interface Props {
  session: string;
  conn: Connection;
  ctrlMode: boolean;
  onCtrlConsumed: () => void;
}

function toControlCharacter(data: string): string | null {
  if (data.length !== 1) return null;
  const char = data.toUpperCase();
  if (char >= 'A' && char <= 'Z') return String.fromCharCode(char.charCodeAt(0) - 64);
  if (char === ' ') return '\x00';
  const specialMap: Record<string, string> = {
    '@': '\x00',
    '[': '\x1b',
    '\\': '\x1c',
    ']': '\x1d',
    '^': '\x1e',
    '_': '\x1f',
  };
  return specialMap[char] ?? null;
}

export function Terminal({ session, conn, ctrlMode, onCtrlConsumed }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [screenText, setScreenText] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const termRef = useRef<XTerm | null>(null);
  const ctrlModeRef = useRef(ctrlMode);
  const onCtrlConsumedRef = useRef(onCtrlConsumed);

  useEffect(() => {
    ctrlModeRef.current = ctrlMode;
  }, [ctrlMode]);

  useEffect(() => {
    onCtrlConsumedRef.current = onCtrlConsumed;
  }, [onCtrlConsumed]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 0, // tmux owns scrollback
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#18181b',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.open(containerRef.current);
    termRef.current = term;

    requestAnimationFrame(() => fitAddon.fit());

    // Listen for refit requests (from refresh button)
    const onRefit = () => {
      fitAddon.fit();
      conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });
      term.scrollToBottom();
    };
    containerRef.current.addEventListener('refit', onRefit);

    const onCopyScreen = () => {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      setScreenText(lines.join('\n'));
    };
    containerRef.current.addEventListener('copy-screen', onCopyScreen);

    conn.send({ type: 'terminal.attach', session });
    conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });

    // Re-attach on reconnect — clear and let ring buffer replay
    const unStatus = conn.onStatus((c) => {
      if (c) {
        term.clear();
        conn.send({ type: 'terminal.attach', session });
        conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });
      }
    });

    term.onData(data => {
      if (ctrlModeRef.current) {
        const modified = toControlCharacter(data);
        if (modified) {
          conn.send({ type: 'terminal.input', session, data: modified });
          onCtrlConsumedRef.current();
          return;
        }
      }
      conn.send({ type: 'terminal.input', session, data });
    });

    // Paste image from clipboard → upload and insert path
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) return;
          const ext = file.type.split('/')[1] || 'png';
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1];
            conn.send({ type: 'files.upload', session, name: `screenshot.${ext}`, data: base64 });
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    };
    document.addEventListener('paste', onPaste);

    // OSC 52 clipboard: \x1b]52;c;<base64>\x07 or \x1b]52;c;<base64>\x1b\\
    const osc52Re = /\x1b\]52;[a-z]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;

    const unsub = conn.subscribe(msg => {
      if (msg.type === 'terminal.output' && msg.session === session) {
        const binary = atob(msg.data);
        // Check for OSC 52 clipboard sequences
        const text = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
        for (const match of text.matchAll(osc52Re)) {
          try {
            const clipText = atob(match[1]);
            navigator.clipboard.writeText(clipText).catch(() => {});
          } catch { /* ignore */ }
        }
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        term.write(bytes);
      }
      if (msg.type === 'terminal.exited' && msg.session === session) {
        term.writeln('\r\n[Session ended]');
      }
      if (msg.type === 'files.uploaded' && msg.session === session) {
        conn.send({ type: 'terminal.input', session, data: msg.path });
      }
    });

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });
    });
    ro.observe(containerRef.current);

    const onFocus = () => {
      if (document.hidden) return;
      fitAddon.fit();
      conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    // Pinch to zoom (mobile)
    const MIN_FONT = 6, MAX_FONT = 28;
    let pinchStartDist = 0, pinchStartFont = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.hypot(dx, dy);
        pinchStartFont = term.options.fontSize || 13;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || pinchStartDist === 0) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / pinchStartDist;
      const newSize = Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, pinchStartFont * scale)));
      if (newSize !== term.options.fontSize) {
        term.options.fontSize = newSize;
        fitAddon.fit();
        conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });
      }
    };

    const onTouchEnd = () => { pinchStartDist = 0; scrolling = false; };

    // Single-finger scroll → tmux mouse wheel events
    let scrollY = 0;
    let scrollAccum = 0;
    let scrolling = false;
    const THRESHOLD = 40; // pixels per scroll line

    const onScrollStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      scrollY = e.touches[0].clientY;
      scrollAccum = 0;
      scrolling = true;
    };

    const onScrollMove = (e: TouchEvent) => {
      if (!scrolling || e.touches.length !== 1 || pinchStartDist !== 0) return;
      const y = e.touches[0].clientY;
      scrollAccum += scrollY - y;
      scrollY = y;

      const lines = Math.trunc(scrollAccum / THRESHOLD);
      if (lines !== 0) {
        const btn = lines > 0 ? 65 : 64;
        const n = Math.abs(lines);
        for (let i = 0; i < n; i++) {
          conn.send({ type: 'terminal.input', session, data: `\x1b[<${btn};1;1M` });
        }
        scrollAccum -= lines * THRESHOLD;
      }
    };

    const onScrollEnd = () => { scrolling = false; };

    // Double-tap right side → Tab key
    let lastTapTime = 0, lastTapX = 0;
    const el = containerRef.current!;

    const onDoubleTapTab = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const now = Date.now();
      const touch = e.touches[0];
      const rect = el.getBoundingClientRect();
      const isRightSide = touch.clientX > rect.left + rect.width / 2;
      if (isRightSide && now - lastTapTime < 300 && Math.abs(touch.clientX - lastTapX) < 50) {
        e.preventDefault();
        conn.send({ type: 'terminal.input', session, data: '\t' });
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        lastTapX = touch.clientX;
      }
    };

    el.addEventListener('touchstart', onDoubleTapTab, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchstart', onScrollStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchmove', onScrollMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchend', onScrollEnd, { passive: true });

    return () => {
      conn.send({ type: 'terminal.detach', session });
      unsub();
      unStatus();
      document.removeEventListener('paste', onPaste);
      ro.disconnect();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      el.removeEventListener('touchstart', onDoubleTapTab);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchstart', onScrollStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchmove', onScrollMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchend', onScrollEnd);
      el.removeEventListener('refit', onRefit);
      el.removeEventListener('copy-screen', onCopyScreen);
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      conn.send({ type: 'files.upload', session, name: file.name, data: base64 });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div
      className="h-full relative"
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div ref={containerRef} className="h-full" data-session={session} />
      {dragOver && (
        <div className="absolute inset-0 z-20 bg-blue-600/20 border-2 border-dashed border-blue-400 flex items-center justify-center pointer-events-none">
          <span className="text-blue-300 text-lg">Drop file to paste path</span>
        </div>
      )}
      {screenText !== null && (
        <div
          className="absolute inset-0 z-20 bg-zinc-900/95 overflow-auto p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setScreenText(null); }}
        >
          <button
            onClick={() => setScreenText(null)}
            className="fixed top-2 right-2 z-30 bg-zinc-700 text-zinc-300 rounded px-3 py-1 text-sm hover:bg-zinc-600"
          >
            Close
          </button>
          <pre className="text-xs text-zinc-200 font-mono whitespace-pre-wrap select-text">{screenText}</pre>
        </div>
      )}
    </div>
  );
}
