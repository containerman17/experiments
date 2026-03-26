// ClaudeMux: tmux sessions in your browser.
// Desktop: left sidebar for session list + big terminal.
// Mobile: full-screen terminal + hamburger menu + bottom toolbar (voice, arrows, enter, keyboard).

import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { SessionInfo, TunnelInfo } from './types';
import { createConnection, type Connection } from './ws';
import { Terminal } from './components/Terminal';
import { FileExplorer } from './components/FileExplorer';
import { VoiceButton } from './components/VoiceButton';
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

const FILES_TAB = '__files__';
const STORAGE_KEY = 'claudemux_url';
const MIC_KEY = 'claudemux_mic';
const TAB_KEY = 'claudemux_tab';
const SIDEBAR_WIDTH_KEY = 'claudemux_sidebar_width';
const SESSION_ALIASES_KEY = 'claudemux_session_aliases';
const DEEPGRAM_API_KEY_KEY = 'claudemux_deepgram_api_key';
const DEEPGRAM_VOCAB_KEY = 'claudemux_deepgram_vocabulary';
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_SESSION_ALIAS_LENGTH = 3;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getSavedUrl(): string {
  return localStorage.getItem(STORAGE_KEY) || '';
}

function getSavedSidebarWidth(): number {
  const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10);
  return Number.isFinite(saved) ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
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
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(DEEPGRAM_API_KEY_KEY) || '');
  const [vocabulary, setVocabulary] = useState(() => localStorage.getItem(DEEPGRAM_VOCAB_KEY) || '');
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    localStorage.setItem(DEEPGRAM_API_KEY_KEY, apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem(DEEPGRAM_VOCAB_KEY, vocabulary);
  }, [vocabulary]);

  const closeSettings = useCallback(() => {
    detailsRef.current?.removeAttribute('open');
  }, []);

  return (
    <details ref={detailsRef} className="px-4 py-2 border-t border-zinc-700" open={defaultOpen}>
      <summary className={`cursor-pointer list-none text-zinc-500 uppercase tracking-[0.18em] ${compact ? 'text-[13px]' : 'text-xs'}`}>
        Settings
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <label className="text-xs text-zinc-500">Deepgram API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="dg_xxx"
            className={`w-full bg-zinc-900 border border-zinc-600 rounded text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-400 ${compact ? 'px-3 py-2 text-sm' : 'px-2 py-1.5 text-xs'}`}
          />
        </div>
        <MicSelector />
        <div className="flex flex-col gap-2">
          <label className="text-xs text-zinc-500">Custom Vocabulary</label>
          <textarea
            value={vocabulary}
            onChange={e => setVocabulary(e.target.value)}
            placeholder="claudemux, tmux, codex, deepgram"
            className={`w-full min-h-[80px] resize-y bg-zinc-900 border border-zinc-600 rounded text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-400 ${compact ? 'px-3 py-2 text-sm' : 'px-2 py-1.5 text-xs'}`}
          />
          <span className="text-[11px] text-zinc-600">Comma-separated. Sent to Deepgram as keyterms.</span>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={closeSettings}
            className={`${compact ? 'px-3 py-2 text-sm' : 'px-2.5 py-1.5 text-xs'} text-zinc-300 hover:text-zinc-100 border border-zinc-600 rounded hover:border-zinc-400 transition-colors cursor-pointer`}
          >
            Save
          </button>
        </div>
      </div>
    </details>
  );
}

function ConnectScreen({ onConnected, autoConnect: shouldAutoConnect = true }: { onConnected: (conn: Connection, url: string) => void; autoConnect?: boolean }) {
  const [url, setUrl] = useState(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    if (token) {
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${location.host}?token=${token}`;
    }
    return getSavedUrl();
  });
  const [status, setStatus] = useState<'idle' | 'connecting' | 'failed'>('idle');
  const connRef = useRef<Connection | null>(null);

  // Auto-connect if URL available (from query params or saved) and not manually disconnected
  const autoConnect = useRef(false);
  useEffect(() => {
    if (url && !autoConnect.current && shouldAutoConnect) {
      autoConnect.current = true;
      handleConnect();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleConnect() {
    if (!url.trim()) return;
    setStatus('connecting');

    // Clean up previous attempt
    connRef.current?.close();

    const conn = createConnection(url.trim());
    connRef.current = conn;

    let timeout: ReturnType<typeof setTimeout>;

    const unsub = conn.onStatus((connected) => {
      if (connected) {
        clearTimeout(timeout);
        unsub();
        localStorage.setItem(STORAGE_KEY, url.trim());
        onConnected(conn, url.trim());
      }
    });

    // 5s timeout
    timeout = setTimeout(() => {
      unsub();
      conn.close();
      connRef.current = null;
      setStatus('failed');
    }, 5000);

    conn.start();
  }

  function handleCancel() {
    connRef.current?.close();
    connRef.current = null;
    setStatus('idle');
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md flex flex-col gap-4">
        <h1 className="text-xl text-zinc-200 text-center">ClaudeMux</h1>
        <input
          type="text"
          value={url}
          onChange={e => { setUrl(e.target.value); setStatus('idle'); }}
          onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
          placeholder="ws://localhost:7938?token=..."
          disabled={status === 'connecting'}
          className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-400 disabled:opacity-50"
          autoFocus
        />
        {status === 'connecting' ? (
          <button
            onClick={handleCancel}
            className="w-full bg-zinc-600 hover:bg-zinc-500 text-white rounded px-3 py-2 text-sm transition-colors"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!url.trim()}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded px-3 py-2 text-sm transition-colors"
          >
            Connect
          </button>
        )}
        {status === 'failed' && (
          <p className="text-red-400 text-sm text-center">Connection failed. Check the URL and try again.</p>
        )}
        <VoiceSettings defaultOpen />
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
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const setActiveSession = useCallback((s: string) => {
    setActiveSessionRaw(s);
    localStorage.setItem(TAB_KEY, s);
  }, []);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [extraKeys, setExtraKeys] = useState(false);
  const [newTunnelPort, setNewTunnelPort] = useState('');
  const [explorerPath, setExplorerPath] = useState('/home/claude');
  const [sidebarWidth, setSidebarWidth] = useState(() => getSavedSidebarWidth());
  const [isResizing, setIsResizing] = useState(false);
  const [sessionAliases, setSessionAliases] = useState<Record<string, string>>(() => getSavedSessionAliases());
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const isMobile = useIsMobile();
  const sessionGroups = useMemo(() => groupSessionsByFolder(sessions), [sessions]);
  const getSessionDisplayName = useCallback((name: string) => sessionAliases[name]?.trim() || name, [sessionAliases]);

  const isTerminalActive = activeSession !== FILES_TAB && sessions.some(s => s.name === activeSession);

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
        // Server already inserted the text into the terminal
      }
      if (msg.type === 'voice.error') {
        console.error('Voice error:', msg.message);
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
    if (activeSession !== FILES_TAB && sessions.length === 0) {
      setActiveSession(FILES_TAB);
    }
  }, [sessions, activeSession]);

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

  useEffect(() => {
    if (!isResizing || isMobile) return;
    const handlePointerMove = (event: PointerEvent) => {
      if (!resizeStateRef.current) return;
      const nextWidth = resizeStateRef.current.startWidth + (event.clientX - resizeStateRef.current.startX);
      setSidebarWidth(clampSidebarWidth(nextWidth));
    };
    const handlePointerUp = () => {
      resizeStateRef.current = null;
      setIsResizing(false);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isResizing, isMobile]);

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
          <Terminal session={s.name} conn={conn} />
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

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    setIsResizing(true);
  }, [isMobile, sidebarWidth]);

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
      <VoiceButton conn={conn} session={activeSession} isMobile={voiceIsMobile} />
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
            onPointerDown={startSidebarResize}
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

  // --- Mobile layout ---
  return (
    <div className="h-full flex flex-col relative">
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
          <div className="w-[90vw] max-w-[28rem] border-r border-zinc-700 h-full flex flex-col shadow-2xl" style={{ backgroundColor: 'rgb(24, 24, 27)' }} onClick={e => e.stopPropagation()}>
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
          <div className="flex-1 bg-black/50" />
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
  const [manualDisconnect, setManualDisconnect] = useState(false);

  if (!state) {
    return <ConnectScreen autoConnect={!manualDisconnect} onConnected={(conn, url) => { setManualDisconnect(false); setState({ conn, url }); }} />;
  }

  return (
    <MainView
      conn={state.conn}
      wsUrl={state.url}
      onDisconnect={() => {
        state.conn.close();
        setManualDisconnect(true);
        setState(null);
      }}
    />
  );
}
