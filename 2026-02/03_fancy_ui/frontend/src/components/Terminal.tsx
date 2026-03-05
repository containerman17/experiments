// Full xterm.js terminal connected to a PTY on the backend via WebSocket.
// On mount, sends `terminal.create` to spawn a shell in the workspace folder.
// User input → `terminal.input`, backend output → `terminal.output` (base64).
// Handles resize via ResizeObserver + FitAddon.

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { send, subscribe } from '../ws';
import { useDispatch } from '../store';

export function Terminal({ folder, tabId, terminalId }: { folder: string; tabId: string; terminalId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dispatch = useDispatch();

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
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
    term.open(containerRef.current);

    // Fit on next frame
    requestAnimationFrame(() => fitAddon.fit());

    let myTerminalId = terminalId || '';

    // If no terminal ID yet, create one
    if (!myTerminalId) {
      send({ type: 'terminal.create', folder });
    }

    // Handle user input
    term.onData(data => {
      if (myTerminalId) {
        send({ type: 'terminal.input', terminalId: myTerminalId, data });
      }
    });

    // Subscribe to WS messages
    const unsub = subscribe(msg => {
      if (msg.type === 'terminal.created' && !myTerminalId) {
        myTerminalId = msg.terminalId;
        dispatch({ type: 'SET_TERMINAL_ID', tabId, terminalId: msg.terminalId });
        // Send initial size
        send({ type: 'terminal.resize', terminalId: myTerminalId, cols: term.cols, rows: term.rows });
      }
      if (msg.type === 'terminal.output' && msg.terminalId === myTerminalId) {
        const decoded = atob(msg.data);
        term.write(decoded);
      }
      if (msg.type === 'terminal.exited' && msg.terminalId === myTerminalId) {
        term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
      }
    });

    // Resize observer
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      if (myTerminalId) {
        send({ type: 'terminal.resize', terminalId: myTerminalId, cols: term.cols, rows: term.rows });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      unsub();
      ro.disconnect();
      term.dispose();
      if (myTerminalId) {
        send({ type: 'terminal.close', terminalId: myTerminalId });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally run once

  return <div ref={containerRef} className="flex-1 min-h-0" />;
}
