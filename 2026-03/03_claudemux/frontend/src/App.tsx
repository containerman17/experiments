// ClaudeMux: tmux sessions in your browser.
// Desktop: left sidebar for session list + big terminal.
// Mobile: full-screen terminal + hamburger menu + bottom toolbar (voice, arrows, enter, keyboard).

import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { SessionInfo, TunnelInfo } from './types';
import { createConnection, type Connection } from './ws';
import { Terminal } from './components/Terminal';
import { FileExplorer } from './components/FileExplorer';
import { VoiceButton, getAutoSend, setAutoSend, onVoiceResult, onVoiceError, getVoiceState, clearLastResult, subscribeVoiceState } from './components/VoiceButton';
import { useIsMobile } from './hooks/useIsMobile';

const EMOJIS = '🔥🚀💡🎯🌊🎨🔮🌿🎪🧊🍊🎭🔑🌈🦊🐙🦋🎲🧩🎵🌸🍄🔔🐝🦜🌵🍀🎸🧲🦀🌶️🫧🐳🦎🔭🧪🎯🪐🌻🐢🦉🧸🎹🍉🔱🦚🌙🐍🦁🍋🎺🧿🐠🌰🦑🎻🍁🪨🐊🌺🧬🦈🎳🍇🔮🐺🌾🦩🧊🐋🎼🍒🔬🦅🌴🧲🐡🎯🍑🔭🦖🌼🧪🐆🎲🍓🔑🦢🌿🧩🐘🎸🍌🔔🦃🌵🧸🐬🎹🍎🔱🦂🌻🧬🐎';
const EMOJI_LIST = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(EMOJIS)].map(s => s.segment);

function emojiHash(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return EMOJI_LIST[Math.abs(hash) % EMOJI_LIST.length];
}

function sessionFolderLabel(name: string): string {
  const parts = name.split('-');
  if (parts.length <= 2) return name;
  return parts.slice(0, -2).join('-') || name;
}

function folderNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '/';
  return trimmed.split('/').pop() || trimmed;
}

function trimFromLeft(text: string, maxChars = 28): string {
  if (text.length <= maxChars) return text;
  return `...${text.slice(-(maxChars - 3))}`;
}

function groupSessionsByFolder(sessions: SessionInfo[]): Array<{ key: string; folder: string; path: string; sessions: SessionInfo[] }> {
  const groups = new Map<string, { key: string; folder: string; path: string; sessions: SessionInfo[] }>();
  for (const session of sessions) {
    const path = session.path || sessionFolderLabel(session.name);
    const key = path;
    const folder = session.path ? folderNameFromPath(session.path) : sessionFolderLabel(session.name);
    if (!groups.has(key)) groups.set(key, { key, folder, path, sessions: [] });
    groups.get(key)!.sessions.push(session);
  }
  return Array.from(groups.values());
}

// Tiny inline notification sound (base64 WAV) — short soft ding
const BELL_SOUND_URI = 'data:audio/wav;base64,UklGRl4DAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YToDAAAAAAEABQAKABIAHQAsAD4AVABuAIwArgDTAPsBJgJTAoIC sgLjAhMDQgNvA5kDwAPjAwAEGAQqBDcEPgQ+BDcEKgQYBAAE4wPAA5kDbwNCA+MC0gKiAnICQgITAuMBsgGBAVEBIQHxAMIAlABnADoADwDm/77/l/9x/03/K/8L/+3+0f63/p/+iv53/mf+Wv5R/kv+SP5I/kz+VP5g/m/+gv6Y/rL+z/7v/hL/N/9f/4n/tf/j/xIAQgBzAKUA1gAIATkBaQGXAcMB7QETAjYCVQJwAocCmQKmAq4CsQKuAqYCmQKHAnACVQI2AhMB7QHDAZcBaQE5AQgB1gClAHMAQgASAOP/tf+J/1//N/8S/+/+z/6y/pj+gv5v/mD+VP5M/kj+SP5L/lH+Wv5n/nf+iv6f/rf+0f7t/gv/K/9N/3H/l/++/+b/DwA6AGcAlADCAAAAAQD+/wAAAQAAAAAA';
let bellAudio: HTMLAudioElement | null = null;
let lastBellTime = 0;
const BELL_DEBOUNCE_MS = 500;

function playBellSound() {
  const now = Date.now();
  if (now - lastBellTime < BELL_DEBOUNCE_MS) return;
  lastBellTime = now;
  if (!bellAudio) bellAudio = new Audio(BELL_SOUND_URI);
  bellAudio.currentTime = 0;
  bellAudio.play().catch(() => {});
}

const FILES_TAB = '__files__';
const MIC_KEY = 'claudemux_mic';
const TAB_KEY = 'claudemux_tab';
const EXPLORER_PATH_KEY = 'claudemux_explorer_path';
const SIDEBAR_WIDTH_KEY = 'claudemux_sidebar_width';
const SESSION_ALIASES_KEY = 'claudemux_session_aliases';
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_SESSION_ALIAS_LENGTH = 3;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getSavedSidebarWidth(): number {
  const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10);
  return Number.isFinite(saved) ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
}

function getSavedExplorerPath(): string {
  return localStorage.getItem(EXPLORER_PATH_KEY) || '/home/claude';
}

function getSavedSessionAliases(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_ALIASES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// --- Connect Screen ---

function MicSelector() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState(() => localStorage.getItem(MIC_KEY) || '');
  const [loaded, setLoaded] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      // Need permission first to get labels
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter(d => d.kind === 'audioinput'));
      setLoaded(true);
    } catch {
      setDevices([]);
    }
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs text-zinc-500">Microphone</label>
        <button
          type="button"
          onClick={loadDevices}
          className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Refresh
        </button>
      </div>
      {!loaded ? (
        <button
          onClick={loadDevices}
          className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-400 hover:border-zinc-400 transition-colors text-left"
        >
          {selected ? 'Tap to refresh mic list' : 'Tap to select microphone'}
        </button>
      ) : (
        <select
          value={selected}
          onChange={e => { setSelected(e.target.value); localStorage.setItem(MIC_KEY, e.target.value); }}
          className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-400"
        >
          <option value="">Default</option>
          {devices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 8)}`}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function VoiceSettings({ compact = false, defaultOpen = false }: { compact?: boolean; defaultOpen?: boolean }) {
  const [autoSendOn, setAutoSendOn] = useState(() => getAutoSend());
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  const toggleAutoSend = useCallback(() => {
    const next = !autoSendOn;
    setAutoSendOn(next);
    setAutoSend(next);
  }, [autoSendOn]);

  const closeSettings = useCallback(() => {
    detailsRef.current?.removeAttribute('open');
  }, []);

  return (
    <details ref={detailsRef} className="px-4 py-2 border-t border-zinc-700" open={defaultOpen}>
      <summary className={`cursor-pointer list-none text-zinc-500 uppercase tracking-[0.18em] ${compact ? 'text-[13px]' : 'text-xs'}`}>
        Settings
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <MicSelector />
        <div className="flex items-center justify-between gap-2">
          <label className={`${compact ? 'text-sm' : 'text-xs'} text-zinc-400`}>Auto-send after transcription</label>
          <button
            type="button"
            onClick={toggleAutoSend}
            className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${autoSendOn ? 'bg-blue-600' : 'bg-zinc-600'}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${autoSendOn ? 'translate-x-5' : ''}`}
            />
          </button>
        </div>
        <span className="text-[11px] text-zinc-600">When on, presses Enter after typing the transcription.</span>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={closeSettings}
            className={`${compact ? 'px-3 py-2 text-sm' : 'px-2.5 py-1.5 text-xs'} text-zinc-300 hover:text-zinc-100 border border-zinc-600 rounded hover:border-zinc-400 transition-colors cursor-pointer`}
          >
            Done
          </button>
        </div>
      </div>
    </details>
  );
}

function getWsUrl(): string {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (!token) return '';
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${location.host}/ws?token=${token}`;
}

function ConnectScreen({ onConnected }: { onConnected: (conn: Connection, url: string) => void }) {
  const [status, setStatus] = useState<'connecting' | 'failed'>('connecting');
  const connRef = useRef<Connection | null>(null);
  const wsUrl = getWsUrl();

  useEffect(() => {
    if (!wsUrl) { setStatus('failed'); return; }

    const conn = createConnection(wsUrl);
    connRef.current = conn;

    const unsub = conn.onStatus((connected) => {
      if (connected) {
        clearTimeout(timeout);
        unsub();
        onConnected(conn, wsUrl);
      }
    });

    const timeout = setTimeout(() => {
      unsub();
      conn.close();
      connRef.current = null;
      setStatus('failed');
    }, 5000);

    conn.start();
    return () => { clearTimeout(timeout); unsub(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md flex flex-col gap-4 text-center">
        <h1 className="text-xl text-zinc-200">ClaudeMux</h1>
        {status === 'connecting' && (
          <p className="text-zinc-400 text-sm animate-pulse">Connecting...</p>
        )}
        {status === 'failed' && (
          <p className="text-red-400 text-sm">{wsUrl ? 'Connection failed.' : 'No token in URL. Open the link from the server.'}</p>
        )}
      </div>
    </div>
  );
}

function MainView({ conn, wsUrl, onDisconnect }: { conn: Connection; wsUrl: string; onDisconnect: () => void }) {
  const [connected, setConnected] = useState(true);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSessionRaw] = useState<string>(() => localStorage.getItem(TAB_KEY) || FILES_TAB);
  const previousSessionsRef = useRef<SessionInfo[] | null>(null);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const setActiveSession = useCallback((s: string) => {
    setActiveSessionRaw(s);
    localStorage.setItem(TAB_KEY, s);
  }, []);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [extraKeys, setExtraKeys] = useState(false);
  const [ctrlMode, setCtrlMode] = useState(false);
  const [newTunnelPort, setNewTunnelPort] = useState('');
  const [explorerPath, setExplorerPath] = useState(() => getSavedExplorerPath());
  const [sidebarWidth, setSidebarWidth] = useState(() => getSavedSidebarWidth());
  const [isResizing, setIsResizing] = useState(false);
  const [sessionAliases, setSessionAliases] = useState<Record<string, string>>(() => getSavedSessionAliases());
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const isMobile = useIsMobile();
  const sessionGroups = useMemo(() => groupSessionsByFolder(sessions), [sessions]);
  const getSessionDisplayName = useCallback((name: string) => sessionAliases[name]?.trim() || name, [sessionAliases]);

  const isTerminalActive = activeSession !== FILES_TAB && sessions.some(s => s.name === activeSession);

  // Subscribe to shared voice state for re-insert buttons & sending indicator
  const [voiceState, setVoiceStateLocal] = useState(() => getVoiceState());
  useEffect(() => subscribeVoiceState(setVoiceStateLocal), []);

  // Bell notification state
  const [bellSessions, setBellSessions] = useState<Set<string>>(new Set());
  const activeSessionRef = useRef(activeSession);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);

  const handleBell = useCallback((session: string) => {
    playBellSound();
    if (session !== activeSessionRef.current) {
      setBellSessions(prev => new Set(prev).add(session));
    }
  }, []);

  // Clear bell when switching to a session
  useEffect(() => {
    setBellSessions(prev => {
      if (!prev.has(activeSession)) return prev;
      const next = new Set(prev);
      next.delete(activeSession);
      return next;
    });
  }, [activeSession]);

  const reinsertText = useCallback((withEnter: boolean) => {
    const lr = getVoiceState().lastResult;
    if (!lr || !isTerminalActive) return;
    conn.send({ type: 'terminal.input', session: activeSession, data: lr.text });
    if (withEnter) {
      setTimeout(() => conn.send({ type: 'terminal.sendkeys', session: activeSession, keys: 'Enter' }), 150);
    }
  }, [activeSession, isTerminalActive, conn]);

  useEffect(() => {
    const unStatus = conn.onStatus(setConnected);
    const unMsg = conn.subscribe(msg => {
      if (msg.type === 'sessions.list') {
        const previousSessions = previousSessionsRef.current;
        if (previousSessions && previousSessions.length > 0) {
          const previousNames = new Set(previousSessions.map(session => session.name));
          const addedSessions = msg.sessions.filter(session => !previousNames.has(session.name));
          if (addedSessions.length > 0) {
            setActiveSession(addedSessions[addedSessions.length - 1].name);
          }
        }
        previousSessionsRef.current = msg.sessions;
        setSessions(msg.sessions);
      }
      if (msg.type === 'voice.result') {
        onVoiceResult(msg.text, msg.session);
      }
      if (msg.type === 'voice.error') {
        console.error('Voice error:', msg.message);
        onVoiceError();
        setToast(msg.message);
        setTimeout(() => setToast(null), 5000);
      }
      if (msg.type === 'tunnels.list') {
        setTunnels(msg.tunnels);
      }
    });
    conn.send({ type: 'sessions.list' });
    conn.send({ type: 'tunnels.list' });
    return () => { unStatus(); unMsg(); };
  }, [conn, setActiveSession]); // eslint-disable-line react-hooks/exhaustive-deps

  // If active session disappeared, fall back
  useEffect(() => {
    if (activeSession !== FILES_TAB && sessions.length > 0 && !sessions.find(s => s.name === activeSession)) {
      setActiveSession(sessions[0].name);
    }
  }, [sessions, activeSession]);

  useEffect(() => {
    localStorage.setItem(EXPLORER_PATH_KEY, explorerPath);
  }, [explorerPath]);

  const createSessionInPath = useCallback((path: string) => {
    if (!path) return;
    conn.send({ type: 'files.createSession', path });
  }, [conn]);

  const sendKey = useCallback((data: string) => {
    if (isTerminalActive) conn.send({ type: 'terminal.input', session: activeSession, data });
  }, [activeSession, isTerminalActive, conn]);

  const refreshTerminal = useCallback(() => {
    if (!isTerminalActive) return;
    // Find the active terminal container and dispatch refit event
    const containers = document.querySelectorAll('[data-session]');
    for (const el of containers) {
      if (el.getAttribute('data-session') === activeSession) {
        el.dispatchEvent(new Event('refit'));
        break;
      }
    }
  }, [activeSession, isTerminalActive]);

  // Re-request session list on reconnect
  useEffect(() => {
    if (connected) {
      conn.send({ type: 'sessions.list' });
      conn.send({ type: 'tunnels.list' });
    }
  }, [connected, conn]);

  useEffect(() => {
    localStorage.setItem(SESSION_ALIASES_KEY, JSON.stringify(sessionAliases));
  }, [sessionAliases]);

  useEffect(() => {
    if (!isMobile) {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    }
  }, [sidebarWidth, isMobile]);

  useEffect(() => {
    if (!renamingSession) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingSession]);

  const toastEl = toast && (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-red-600 text-white px-4 py-2 rounded shadow-lg text-sm max-w-sm truncate">
      {toast}
    </div>
  );

  const reconnectingEl = !connected && (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-amber-600 text-white px-4 py-2 rounded shadow-lg text-sm animate-pulse">
      Reconnecting...
    </div>
  );

  const terminalArea = (
    <div className="flex-1 min-h-0 min-w-0 relative">
      <div className={`absolute inset-0 z-10 ${activeSession === FILES_TAB ? '' : 'invisible'}`}>
          <FileExplorer conn={conn} initialPath={explorerPath} />
      </div>
      {sessions.map(s => (
        <div
          key={s.name}
          className={`absolute inset-0 ${activeSession === s.name ? '' : 'invisible'}`}
        >
          <Terminal session={s.name} conn={conn} ctrlMode={ctrlMode} onCtrlConsumed={() => setCtrlMode(false)} onBell={() => handleBell(s.name)} />
        </div>
      ))}
    </div>
  );

  const beginSessionRename = useCallback((sessionName: string) => {
    setRenamingSession(sessionName);
    setRenameValue(getSessionDisplayName(sessionName));
  }, [getSessionDisplayName]);

  const cancelSessionRename = useCallback(() => {
    setRenamingSession(null);
    setRenameValue('');
  }, []);

  const saveSessionRename = useCallback((sessionName: string) => {
    const trimmed = renameValue.trim();
    if (trimmed.length < MIN_SESSION_ALIAS_LENGTH) {
      cancelSessionRename();
      return;
    }
    setSessionAliases(prev => {
      const next = { ...prev };
      if (trimmed === sessionName) {
        delete next[sessionName];
      } else {
        next[sessionName] = trimmed;
      }
      return next;
    });
    setRenamingSession(current => current === sessionName ? null : current);
    setRenameValue('');
  }, [cancelSessionRename, renameValue]);

  const stopSidebarResize = useCallback(() => {
    resizeStateRef.current = null;
    setIsResizing(false);
  }, []);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isMobile || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    setIsResizing(true);
  }, [isMobile, sidebarWidth]);

  const handleSidebarResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeStateRef.current || !event.isPrimary) return;
    event.preventDefault();
    const nextWidth = resizeStateRef.current.startWidth + (event.clientX - resizeStateRef.current.startX);
    setSidebarWidth(clampSidebarWidth(nextWidth));
  }, []);

  const handleSidebarResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopSidebarResize();
  }, [stopSidebarResize]);

  const sessionItems = (onClick?: () => void) => (
    <>
      {sessionGroups.map(group => (
        <div key={group.key} className="border-b border-zinc-700 pt-2 last:border-b-0">
          <div className={`${isMobile ? 'pl-4 pr-3 pt-3 pb-2' : 'pl-4 pr-2 pt-2 pb-1'} flex items-center gap-2`}>
            <div className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis text-zinc-500 uppercase tracking-[0.18em] ${isMobile ? 'text-[13px]' : 'text-xs'}`}>
              {trimFromLeft(group.folder, 30)}
            </div>
            <div className={`ml-auto flex items-center shrink-0 ${isMobile ? 'gap-2' : 'gap-1'}`}>
              <button
                onClick={() => { setExplorerPath(group.path); setActiveSession(FILES_TAB); onClick?.(); }}
                className={`${isMobile ? 'p-2' : 'p-1'} rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer`}
                title={`Open ${group.path} in file explorer`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={isMobile ? 'w-5 h-5' : 'w-3.5 h-3.5'}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5A2.25 2.25 0 016 5.25h4.19a2.25 2.25 0 011.59.66l.81.84h5.41a2.25 2.25 0 012.25 2.25v7.5A2.25 2.25 0 0118 18.75H6A2.25 2.25 0 013.75 16.5v-9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 12h7.5" />
                </svg>
              </button>
              <button
                onClick={() => createSessionInPath(group.path)}
                className={`${isMobile ? 'p-2' : 'p-1'} rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer`}
                title={`New terminal in ${group.path}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={isMobile ? 'w-5 h-5' : 'w-3.5 h-3.5'}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7.5A1.5 1.5 0 015.5 6h13A1.5 1.5 0 0120 7.5v9A1.5 1.5 0 0118.5 18h-13A1.5 1.5 0 014 16.5v-9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 10.5l2 2-2 2M12.5 14.5h4" />
                </svg>
              </button>
            </div>
          </div>
          {group.sessions.map(s => (
            <div
              key={s.name}
              role="button"
              tabIndex={0}
              onClick={() => { setActiveSession(s.name); onClick?.(); }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginSessionRename(s.name);
              }}
              onKeyDown={(e) => {
                if (renamingSession === s.name) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveSession(s.name);
                  onClick?.();
                }
              }}
              title={s.name}
              className={`w-full text-left transition-colors flex items-center gap-2 cursor-pointer ${
                isMobile ? 'px-4 py-3 text-base' : 'px-4 py-2 text-sm'
              } ${
                activeSession === s.name
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              <span>{emojiHash(s.name)}</span>
              {renamingSession === s.name ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  minLength={MIN_SESSION_ALIAS_LENGTH}
                  onChange={e => setRenameValue(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onDoubleClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') saveSessionRename(s.name);
                    if (e.key === 'Escape') cancelSessionRename();
                  }}
                  onBlur={() => saveSessionRename(s.name)}
                  className="min-w-0 flex-1 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-zinc-400"
                />
              ) : (
                <span className="min-w-0 overflow-hidden whitespace-nowrap">{trimFromLeft(getSessionDisplayName(s.name), 32)}</span>
              )}
              {bellSessions.has(s.name) && (
                <svg className="w-4 h-4 text-amber-400 animate-pulse ml-auto shrink-0" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2a1 1 0 011 1v1.07A7.002 7.002 0 0119 11v3.76l1.71 1.71A1 1 0 0120 18H4a1 1 0 01-.71-1.71L5 14.59V11a7.002 7.002 0 016-6.93V3a1 1 0 011-1zM10 20h4a2 2 0 01-4 0z" />
                </svg>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="pt-2">
        <div className={`px-4 pb-1 text-zinc-500 uppercase tracking-[0.18em] ${isMobile ? 'text-[13px]' : 'text-xs'}`}>
          Files
        </div>
        <button
          onClick={() => { setActiveSession(FILES_TAB); onClick?.(); }}
          className={`w-full text-left transition-colors flex items-center gap-2 ${
            isMobile ? 'px-4 py-3 text-base' : 'px-4 py-2 text-sm'
          } ${
            activeSession === FILES_TAB
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
          } cursor-pointer`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
            <path strokeLinecap="round" d="M12 5v14M5 12h14" />
          </svg>
          Open File Explorer
        </button>
      </div>
    </>
  );

  const tunnelItems = (
    <div className="px-4 py-2 flex flex-col gap-1">
      <div className={`text-zinc-500 uppercase tracking-[0.18em] mb-1 ${isMobile ? 'text-[13px]' : 'text-xs'}`}>Tunnels</div>
      {tunnels.map(t => (
        <div key={t.port} className={`flex items-center gap-1 ${isMobile ? 'text-sm py-0.5' : 'text-xs'}`}>
          <span className="text-zinc-400 shrink-0">:{t.port}</span>
          {t.status === 'starting' && <span className="text-amber-400 animate-pulse truncate">starting...</span>}
          {t.status === 'running' && t.url && (
            <a href={t.url} target="_blank" rel="noopener" className="text-blue-400 hover:text-blue-300 truncate">{t.url.replace('https://', '')}</a>
          )}
          {t.status === 'error' && <span className="text-red-400 truncate">{t.error || 'error'}</span>}
          <button
            onClick={() => conn.send({ type: 'tunnels.delete', port: t.port })}
            className={`ml-auto shrink-0 text-zinc-500 hover:text-zinc-300 cursor-pointer ${isMobile ? 'p-1' : ''}`}
            title="Delete tunnel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'}>
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <form className="flex gap-1 mt-1" onSubmit={e => {
        e.preventDefault();
        const p = parseInt(newTunnelPort, 10);
        if (p > 0 && p < 65536) {
          conn.send({ type: 'tunnels.create', port: p });
          setNewTunnelPort('');
        }
      }}>
        <input
          type="number"
          value={newTunnelPort}
          onChange={e => setNewTunnelPort(e.target.value)}
          placeholder="port"
          className={`bg-zinc-900 border border-zinc-600 rounded text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-400 ${isMobile ? 'w-24 px-3 py-1.5 text-sm' : 'w-20 px-2 py-1 text-xs'}`}
        />
        <button type="submit" className={`${isMobile ? 'text-sm px-3 py-1.5' : 'text-xs px-2 py-1'} text-zinc-400 hover:text-zinc-200 border border-zinc-600 rounded hover:border-zinc-400 cursor-pointer`}>Add</button>
      </form>
    </div>
  );

  const disconnectBtn = (
    <button
      onClick={() => { conn.close(); onDisconnect(); }}
      className="px-4 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors w-full text-left"
      title={wsUrl}
    >
      Disconnect
    </button>
  );

  const extraKeyRows = (buttonClass: string, rowClass: string) => (
    <>
      <div className={rowClass}>
        <button onClick={() => sendKey('\x1b[A')} className={`${buttonClass} text-xs`} title="Up">↑</button>
        <button onClick={() => sendKey('\x1b[B')} className={`${buttonClass} text-xs`} title="Down">↓</button>
        <button onClick={() => sendKey('\x1b[D')} className={`${buttonClass} text-xs`} title="Left">←</button>
        <button onClick={() => sendKey('\x1b[C')} className={`${buttonClass} text-xs`} title="Right">→</button>
        <button onClick={() => sendKey('\x1b[Z')} className={`${buttonClass} text-xs`} title="Shift-Tab">S-Tab</button>
        <button onClick={async () => {
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const imageType = item.types.find(t => t.startsWith('image/'));
              if (imageType) {
                const blob = await item.getType(imageType);
                const ext = imageType.split('/')[1] || 'png';
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = (reader.result as string).split(',')[1];
                  conn.send({ type: 'files.upload', session: activeSession, name: `screenshot.${ext}`, data: base64 });
                };
                reader.readAsDataURL(blob);
                return;
              }
              if (item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                const text = await blob.text();
                if (text) sendKey(text);
                return;
              }
            }
          } catch {
            navigator.clipboard.readText().then(text => { if (text) sendKey(text); }).catch(() => {});
          }
        }} className={`${buttonClass} text-xs`} title="Paste">Paste</button>
        <button onClick={() => {
          const el = document.querySelector(`[data-session="${activeSession}"]`);
          if (el) el.dispatchEvent(new CustomEvent('copy-screen'));
        }} className={`${buttonClass} text-xs`} title="Copy screen">Sel</button>
      </div>
      <div className={rowClass}>
        <button
          onClick={() => setCtrlMode(value => !value)}
          className={`${buttonClass} text-xs ${ctrlMode ? '!bg-blue-600 !text-white' : ''}`}
          title="Control modifier"
        >
          Ctrl
        </button>
        <button onClick={() => sendKey('\x03')} className={`${buttonClass} text-xs`} title="Ctrl-C">^C</button>
        <button onClick={() => sendKey('\x02')} className={`${buttonClass} text-xs`} title="Ctrl-B">^B</button>
        <button onClick={() => { sendKey('\x02'); setTimeout(() => sendKey('\x02'), 50); }} className={`${buttonClass} text-xs`} title="Ctrl-B Ctrl-B">^B^B</button>
        <button onClick={() => sendKey('\x0f')} className={`${buttonClass} text-xs`} title="Ctrl-O">^O</button>
        <button onClick={() => sendKey('\x1b')} className={`${buttonClass} text-xs`} title="Escape">Esc</button>
      </div>
    </>
  );

  const mainControlsRow = (buttonClass: string, rowClass: string, voiceIsMobile: boolean) => (
    <div className={rowClass}>
      <VoiceButton conn={conn} session={isTerminalActive ? activeSession : null} isMobile={voiceIsMobile} />
      {voiceState.sending && (
        <span className="text-yellow-400 text-xs animate-pulse whitespace-nowrap">transcribing...</span>
      )}
      {voiceState.lastResult && !voiceState.sending && (
        <>
          <button
            onClick={() => reinsertText(false)}
            className={`${buttonClass} text-xs max-w-[8rem] truncate`}
            title={`Re-type: ${voiceState.lastResult.text}`}
          >
            Re-type
          </button>
          <button
            onClick={() => reinsertText(true)}
            className={`${buttonClass} text-xs`}
            title={`Re-type + Enter: ${voiceState.lastResult.text}`}
          >
            +↵
          </button>
          <button
            onClick={() => clearLastResult()}
            className={`${buttonClass} text-xs text-zinc-500`}
            title="Dismiss"
          >
            ×
          </button>
        </>
      )}
      <div className="flex-1" />
      <button
        onClick={() => sendKey('\r')}
        className={`${buttonClass} !bg-blue-600 !text-white cursor-pointer`}
        title="Enter"
      >
        <span className={isMobile ? 'text-base font-mono leading-none' : 'text-sm font-mono leading-none'}>↵</span>
      </button>
      <button onClick={refreshTerminal} className={buttonClass} title="Refresh & scroll down">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
          <path strokeLinecap="round" d="M20.49 9A9 9 0 005.64 5.64L4 9m16 6l-1.64 3.36A9 9 0 014.51 15" />
        </svg>
      </button>
      <button
        onClick={() => setExtraKeys(!extraKeys)}
        className={`${buttonClass} ${extraKeys ? '!bg-zinc-600' : ''}`}
        title="Extra keys"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
          <path strokeLinecap="round" d="M8 6h.01M12 6h.01M16 6h.01M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
        </svg>
      </button>
    </div>
  );

  // --- Desktop layout ---
  if (!isMobile) {
    return (
      <div
        className={`h-full relative p-3 ${isResizing ? 'select-none cursor-col-resize' : ''}`}
        style={{ backgroundColor: 'rgb(24, 24, 27)', fontFamily: 'Menlo, Monaco, \"Courier New\", monospace' }}
      >
        {toastEl}
        {reconnectingEl}
        <div className="h-full flex">
          <div
            className="shrink-0 flex flex-col border-r border-zinc-700"
            style={{ width: sidebarWidth, backgroundColor: 'rgb(24, 24, 27)' }}
          >
            <div className="flex-1 overflow-y-auto">
              {sessionItems()}
              <div className="border-t border-zinc-700">{tunnelItems}</div>
            </div>
            <div className="border-t border-zinc-700 py-1">
              {isTerminalActive && (
                <div className="border-b border-zinc-700">
                  {extraKeys && extraKeyRows('toolbar-btn', 'px-2 py-1.5 flex items-center gap-1 border-b border-zinc-700')}
                  {mainControlsRow('toolbar-btn', 'px-2 py-2 flex items-center gap-1', true)}
                </div>
              )}
              <VoiceSettings />
              {disconnectBtn}
              <div className="px-4 pb-1 text-[10px] text-zinc-600">{new Date(__BUILD_TIME__).toLocaleString()}</div>
            </div>
          </div>
          <div
            ref={resizeHandleRef}
            onPointerDown={startSidebarResize}
            onPointerMove={handleSidebarResizeMove}
            onPointerUp={handleSidebarResizeEnd}
            onPointerCancel={handleSidebarResizeEnd}
            onLostPointerCapture={stopSidebarResize}
            className="w-2 shrink-0 cursor-col-resize hover:bg-zinc-700/40 active:bg-zinc-600/50 transition-colors touch-none"
            title="Resize sidebar"
          />
          <div className="flex-1 min-w-0 h-full flex relative pl-1">
            {terminalArea}
          </div>
        </div>
      </div>
    );
  }

  // --- Swipe from left edge to open drawer ---
  const mobileContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = mobileContainerRef.current;
    if (!el) return;
    const EDGE_ZONE = 30; // px from left edge to start swipe
    const MIN_SWIPE = 50; // px horizontal distance to trigger
    let startX = 0, startY = 0, tracking = false;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch.clientX <= EDGE_ZONE) {
        startX = touch.clientX;
        startY = touch.clientY;
        tracking = true;
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (dx > MIN_SWIPE && dx > dy) {
        setMenuOpen(true);
      }
    };
    const onTouchCancel = () => { tracking = false; };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, []);

  // --- Mobile layout ---
  return (
    <div ref={mobileContainerRef} className="h-full flex flex-col relative">
      {toastEl}
      {reconnectingEl}
      {/* Top bar */}
      <div className="shrink-0 border-b border-zinc-700 flex items-center px-3 py-2 gap-2" style={{ backgroundColor: 'rgb(24, 24, 27)' }}>
        <button onClick={() => setMenuOpen(!menuOpen)} className="p-1 rounded hover:bg-zinc-700 text-zinc-400 cursor-pointer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        {activeSession === FILES_TAB ? (
          <span className="text-sm text-zinc-300 truncate flex-1">File Explorer</span>
        ) : renamingSession === activeSession ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            minLength={MIN_SESSION_ALIAS_LENGTH}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') saveSessionRename(activeSession);
              if (e.key === 'Escape') cancelSessionRename();
            }}
            onBlur={() => saveSessionRename(activeSession)}
            className="min-w-0 flex-1 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-zinc-400"
          />
        ) : (
          <button
            onDoubleClick={() => beginSessionRename(activeSession)}
            className="text-sm text-zinc-300 truncate flex-1 text-left cursor-pointer"
            title="Double tap to rename session"
          >
            {`${emojiHash(activeSession)} ${trimFromLeft(getSessionDisplayName(activeSession), 32)}`}
          </button>
        )}
      </div>

      {/* Slide-over menu */}
      {menuOpen && (
        <div className="absolute inset-0 z-50 flex" onClick={() => setMenuOpen(false)}>
          <div
            className="w-[90vw] max-w-[28rem] border-r border-zinc-700 h-full flex flex-col shadow-2xl"
            style={{ backgroundColor: 'rgb(24, 24, 27)', animation: 'drawer-slide-in 200ms ease-out' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex-1 overflow-y-auto">
              {sessionItems(() => setMenuOpen(false))}
              <div className="border-t border-zinc-700 mt-2">{tunnelItems}</div>
              <VoiceSettings compact />
            </div>
            <div className="border-t border-zinc-700 flex flex-col items-center py-2 gap-0.5">
              {disconnectBtn}
              <span className="text-[10px] text-zinc-600">{new Date(__BUILD_TIME__).toLocaleString()}</span>
            </div>
          </div>
          <div className="flex-1" style={{ backgroundColor: 'rgba(0,0,0,0.5)', animation: 'drawer-fade-in 200ms ease-out' }} />
        </div>
      )}

      {terminalArea}

      {/* Bottom toolbar — only when a terminal is active */}
      {isTerminalActive && (
        <div className="shrink-0 bg-zinc-800 border-t border-zinc-700">
          {extraKeys && extraKeyRows('toolbar-btn', 'px-2 py-1.5 flex items-center gap-1 border-b border-zinc-700')}
          {mainControlsRow('toolbar-btn', 'px-2 py-2 flex items-center gap-1', true)}
        </div>
      )}
    </div>
  );
}

// --- Root ---

export function App() {
  const [state, setState] = useState<{ conn: Connection; url: string } | null>(null);

  if (!state) {
    return <ConnectScreen onConnected={(conn, url) => setState({ conn, url })} />;
  }

  return (
    <MainView
      conn={state.conn}
      wsUrl={state.url}
      onDisconnect={() => {
        state.conn.close();
        setState(null);
      }}
    />
  );
}
