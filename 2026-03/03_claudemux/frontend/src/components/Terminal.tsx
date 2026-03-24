// xterm.js terminal connected to a tmux session via WebSocket.
// Attaches on mount, replays ring buffer, streams output.
// Does NOT close the tmux session on unmount — sessions are persistent.

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { Connection } from '../ws';

interface Props {
  session: string;
  conn: Connection;
}

export function Terminal({ session, conn }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 10000,
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

    requestAnimationFrame(() => fitAddon.fit());

    // Listen for refit requests (from refresh button)
    const onRefit = () => {
      fitAddon.fit();
      conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });
      term.scrollToBottom();
    };
    containerRef.current.addEventListener('refit', onRefit);

    conn.send({ type: 'terminal.attach', session });
    conn.send({ type: 'terminal.resize', session, cols: term.cols, rows: term.rows });

    term.onData(data => {
      conn.send({ type: 'terminal.input', session, data });
    });

    const unsub = conn.subscribe(msg => {
      if (msg.type === 'terminal.output' && msg.session === session) {
        const binary = atob(msg.data);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        term.write(bytes);
      }
      if (msg.type === 'terminal.exited' && msg.session === session) {
        term.writeln('\r\n[Session ended]');
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

    const onTouchEnd = () => { pinchStartDist = 0; };

    // Single-finger scroll with inertia
    let scrollY = 0;
    let scrollVelocity = 0;
    let scrollLastTime = 0;
    let scrolling = false;
    let inertiaRaf = 0;
    const LINE_HEIGHT = Math.round((term.options.fontSize || 13) * 1.2);

    const onScrollStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      cancelAnimationFrame(inertiaRaf);
      scrollY = e.touches[0].clientY;
      scrollVelocity = 0;
      scrollLastTime = Date.now();
      scrolling = true;
    };

    const onScrollMove = (e: TouchEvent) => {
      if (!scrolling || e.touches.length !== 1 || pinchStartDist !== 0) return;
      const y = e.touches[0].clientY;
      const dy = scrollY - y;
      const now = Date.now();
      const dt = now - scrollLastTime;
      if (dt > 0) scrollVelocity = dy / dt; // px/ms
      scrollLastTime = now;
      scrollY = y;

      const lines = Math.round(dy / LINE_HEIGHT);
      if (lines !== 0) {
        term.scrollLines(lines);
        scrollY += (lines * LINE_HEIGHT - dy); // correct remainder
      }
    };

    const onScrollEnd = () => {
      if (!scrolling) return;
      scrolling = false;

      // Inertia: decay velocity over time
      const friction = 0.95;
      let v = scrollVelocity * 16; // convert px/ms to px/frame (~16ms)

      const tick = () => {
        v *= friction;
        if (Math.abs(v) < 0.5) return;
        const lines = Math.round(v / LINE_HEIGHT);
        if (lines !== 0) term.scrollLines(lines);
        inertiaRaf = requestAnimationFrame(tick);
      };
      inertiaRaf = requestAnimationFrame(tick);
    };

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
      ro.disconnect();
      cancelAnimationFrame(inertiaRaf);
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
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="h-full" data-session={session} />;
}
