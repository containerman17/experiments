// Full xterm.js terminal connected to a PTY on the backend via WebSocket.
// Supports two modes:
//   1. Create new: sends `terminal.create`, then auto-attaches on `terminal.created` response
//   2. Attach existing: sends `terminal.attach` with known terminalId (replays ring buffer)
// User input → `terminal.input`, backend output → `terminal.output` (base64).
// Handles resize via ResizeObserver + FitAddon.
// Does NOT send `terminal.close` on unmount — terminals are persistent.

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { send, subscribe } from '../ws';

export function Terminal({ terminalId }: { terminalId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono NF", Menlo, Monaco, "Courier New", monospace',
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

    // Fit on next frame
    requestAnimationFrame(() => fitAddon.fit());

    // Attach to existing terminal — backend will replay ring buffer
    send({ type: 'terminal.attach', terminalId });
    send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows });

    // Handle user input
    term.onData(data => {
      send({ type: 'terminal.input', terminalId, data });
    });

    // Subscribe to WS messages
    const unsub = subscribe(msg => {
      if (msg.type === 'terminal.output' && msg.terminalId === terminalId) {
        const binary = atob(msg.data);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        term.write(bytes);
      }
      if (msg.type === 'terminal.exited' && msg.terminalId === terminalId) {
        term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
      }
    });

    // Resize observer
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows });
    });
    ro.observe(containerRef.current);

    // Re-fit on focus/visibility change (e.g. switching devices via tunnel)
    const onFocus = () => {
      if (document.hidden) return;
      fitAddon.fit();
      send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      unsub();
      ro.disconnect();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      term.dispose();
      // Don't close the terminal — it's persistent. Just detach by unsubscribing.
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally run once

  return <div ref={containerRef} className="flex-1 min-h-0" />;
}
