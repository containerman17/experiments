// ClaudeMux: tmux sessions in your browser.
// Desktop: left sidebar for session list + big terminal.
// Mobile: full-screen terminal + hamburger menu + bottom toolbar (voice, arrows, enter, keyboard).

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { SessionInfo, TunnelInfo } from './types';
import randomName from '@scaleway/random-name';
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

const NEW_TAB = '__new__';
const FILES_TAB = '__files__';
const STORAGE_KEY = 'claudemux_url';
const MIC_KEY = 'claudemux_mic';
const TAB_KEY = 'claudemux_tab';

function getSavedUrl(): string {
  return localStorage.getItem(STORAGE_KEY) || '';
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
      <label className="text-xs text-zinc-500">Microphone</label>
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
        <MicSelector />
      </div>
    </div>
  );
}

// --- New Session Panel ---

function NewSessionPanel() {
  const suffix = useMemo(() => randomName(), []);
  const cmd = `tmux -L claudemux new-session -s "$(basename $PWD)-${suffix}"`;
  return (
    <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-4 p-8 text-center">
      <p className="text-lg">New Session</p>
      <p className="text-sm">Create a tmux session:</p>
      <code
        className="bg-zinc-800 px-4 py-2 rounded text-zinc-300 text-sm select-all cursor-pointer block"
        onClick={() => { navigator.clipboard.writeText(cmd); }}
      >
        {cmd}
      </code>
      <p className="text-xs text-zinc-600 max-w-sm">
        Click to copy. It will appear here automatically.
      </p>
    </div>
  );
}

// --- Main App ---

function MainView({ conn, wsUrl, onDisconnect }: { conn: Connection; wsUrl: string; onDisconnect: () => void }) {
  const [connected, setConnected] = useState(true);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSessionRaw] = useState<string>(() => localStorage.getItem(TAB_KEY) || NEW_TAB);
  const setActiveSession = useCallback((s: string) => {
    setActiveSessionRaw(s);
    localStorage.setItem(TAB_KEY, s);
  }, []);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [extraKeys, setExtraKeys] = useState(false);
  const [newTunnelPort, setNewTunnelPort] = useState('');
  const isMobile = useIsMobile();

  const isTerminalActive = activeSession !== NEW_TAB && activeSession !== FILES_TAB && sessions.some(s => s.name === activeSession);

  useEffect(() => {
    const unStatus = conn.onStatus(setConnected);
    const unMsg = conn.subscribe(msg => {
      if (msg.type === 'sessions.list') {
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
  }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps

  // If active session disappeared, fall back
  useEffect(() => {
    if (activeSession !== NEW_TAB && activeSession !== FILES_TAB && sessions.length > 0 && !sessions.find(s => s.name === activeSession)) {
      setActiveSession(sessions[0].name);
    }
    if (activeSession !== NEW_TAB && activeSession !== FILES_TAB && sessions.length === 0) {
      setActiveSession(NEW_TAB);
    }
  }, [sessions, activeSession]);

  const sendKey = useCallback((data: string) => {
    if (isTerminalActive) conn.send({ type: 'terminal.input', session: activeSession, data });
  }, [activeSession, isTerminalActive, conn]);

  const focusTerminal = useCallback(() => {
    const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    textarea?.focus();
  }, []);

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
      {activeSession === NEW_TAB && (
        <div className="absolute inset-0 z-10">
          <NewSessionPanel />
        </div>
      )}
      {activeSession === FILES_TAB && (
        <div className="absolute inset-0 z-10">
          <FileExplorer conn={conn} onSessionCreated={() => {
            // Switch to the new session once it appears in the next sessions.list broadcast
            const unsub = conn.subscribe(msg => {
              if (msg.type === 'sessions.list' && msg.sessions.length > 0) {
                unsub();
                setActiveSession(msg.sessions[msg.sessions.length - 1].name);
              }
            });
          }} />
        </div>
      )}
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

  const sessionItems = (onClick?: () => void) => (
    <>
      {sessions.map(s => (
        <button
          key={s.name}
          onClick={() => { setActiveSession(s.name); onClick?.(); }}
          className={`w-full text-left px-3 py-2 text-sm truncate transition-colors flex items-center gap-2 cursor-pointer ${
            activeSession === s.name
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200'
          }`}
        >
          <span>{emojiHash(s.name)}</span>
          {s.name}
        </button>
      ))}
      <button
        onClick={() => { setActiveSession(NEW_TAB); onClick?.(); }}
        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
          activeSession === NEW_TAB
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-500 hover:bg-zinc-700/50 hover:text-zinc-300'
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
          <path strokeLinecap="round" d="M12 5v14M5 12h14" />
        </svg>
        New Session
      </button>
    </>
  );

  const filesSection = (onClick?: () => void) => (
    <div className="border-t border-zinc-700 mt-2">
      <div className="px-3 py-2 text-xs text-zinc-500 uppercase tracking-wider">Files</div>
      <button
        onClick={() => { setActiveSession(FILES_TAB); onClick?.(); }}
        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 cursor-pointer ${
          activeSession === FILES_TAB
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-500 hover:bg-zinc-700/50 hover:text-zinc-300'
        }`}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
          <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        Open File Explorer
      </button>
    </div>
  );

  const tunnelItems = (
    <div className="px-3 py-2 flex flex-col gap-1">
      <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Tunnels</div>
      {tunnels.map(t => (
        <div key={t.port} className="flex items-center gap-1 text-xs">
          <span className="text-zinc-400 shrink-0">:{t.port}</span>
          {t.status === 'starting' && <span className="text-amber-400 animate-pulse truncate">starting...</span>}
          {t.status === 'running' && t.url && (
            <a href={t.url} target="_blank" rel="noopener" className="text-blue-400 hover:text-blue-300 truncate">{t.url.replace('https://', '')}</a>
          )}
          {t.status === 'error' && <span className="text-red-400 truncate">{t.error || 'error'}</span>}
          <button
            onClick={() => conn.send({ type: 'tunnels.delete', port: t.port })}
            className="ml-auto shrink-0 text-zinc-500 hover:text-zinc-300"
            title="Delete tunnel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
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
          className="w-20 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-400"
        />
        <button type="submit" className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 border border-zinc-600 rounded hover:border-zinc-400">Add</button>
      </form>
    </div>
  );

  const disconnectBtn = (
    <button
      onClick={() => { conn.close(); onDisconnect(); }}
      className="px-3 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      title={wsUrl}
    >
      Disconnect
    </button>
  );

  // --- Desktop layout ---
  if (!isMobile) {
    return (
      <div className="h-full flex relative">
        {toastEl}
        {reconnectingEl}
        <div className="w-72 shrink-0 bg-zinc-800 border-r border-zinc-700 flex flex-col relative">
          <div className="px-3 py-2 text-xs text-zinc-500 uppercase tracking-wider">Sessions</div>
          <div className="flex-1 overflow-y-auto">
            {sessionItems()}
            {filesSection()}
            <div className="border-t border-zinc-700 mt-2">{tunnelItems}</div>
          </div>
          <div className="border-t border-zinc-700 flex flex-col items-center py-1 gap-0.5">
            {disconnectBtn}
            <span className="text-[10px] text-zinc-600">{new Date(__BUILD_TIME__).toLocaleString()}</span>
          </div>
          {isTerminalActive && (
            <div className="absolute bottom-12 -right-5 z-20 bg-zinc-800 rounded-full p-1 shadow-lg border border-zinc-700">
              <VoiceButton conn={conn} session={activeSession} isMobile={false} />
            </div>
          )}
        </div>
        {terminalArea}
      </div>
    );
  }

  // --- Mobile layout ---
  return (
    <div className="h-full flex flex-col relative">
      {toastEl}
      {reconnectingEl}
      {/* Top bar */}
      <div className="shrink-0 bg-zinc-800 border-b border-zinc-700 flex items-center px-3 py-2 gap-2">
        <button onClick={() => setMenuOpen(!menuOpen)} className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-sm text-zinc-300 truncate flex-1">
          {activeSession === NEW_TAB ? 'New Session' : activeSession === FILES_TAB ? 'File Explorer' : `${emojiHash(activeSession)} ${activeSession}`}
        </span>
      </div>

      {/* Slide-over menu */}
      {menuOpen && (
        <div className="absolute inset-0 z-50 flex" onClick={() => setMenuOpen(false)}>
          <div className="w-64 bg-zinc-800 border-r border-zinc-700 h-full flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-3 py-3 text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-700">Sessions</div>
            <div className="flex-1 overflow-y-auto">
              {sessionItems(() => setMenuOpen(false))}
              {filesSection(() => setMenuOpen(false))}
              <div className="border-t border-zinc-700 mt-2">{tunnelItems}</div>
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
          {/* Extra keys row (toggleable) */}
          {extraKeys && (
            <>
              {/* Row 1: navigation + common */}
              <div className="px-2 py-1.5 flex items-center gap-1 border-b border-zinc-700">
                <button onClick={() => sendKey('\x1b[A')} className="toolbar-btn text-xs" title="Up">↑</button>
                <button onClick={() => sendKey('\x1b[B')} className="toolbar-btn text-xs" title="Down">↓</button>
                <button onClick={() => sendKey('\x1b[D')} className="toolbar-btn text-xs" title="Left">←</button>
                <button onClick={() => sendKey('\x1b[C')} className="toolbar-btn text-xs" title="Right">→</button>
                <button onClick={() => sendKey('\r')} className="toolbar-btn text-xs !bg-blue-600 !text-white" title="Enter">↵</button>
                <button onClick={async () => {
                  try {
                    const items = await navigator.clipboard.read();
                    for (const item of items) {
                      // Check for image first
                      const imageType = item.types.find(t => t.startsWith('image/'));
                      if (imageType) {
                        const blob = await item.getType(imageType);
                        const ext = imageType.split('/')[1] || 'png';
                        const reader = new FileReader();
                        reader.onload = () => {
                          const base64 = (reader.result as string).split(',')[1];
                          conn.send({ type: 'files.upload', name: `screenshot.${ext}`, data: base64 });
                        };
                        reader.readAsDataURL(blob);
                        return;
                      }
                      // Fall back to text
                      if (item.types.includes('text/plain')) {
                        const blob = await item.getType('text/plain');
                        const text = await blob.text();
                        if (text) sendKey(text);
                        return;
                      }
                    }
                  } catch {
                    // Fallback for browsers that don't support clipboard.read()
                    navigator.clipboard.readText().then(text => { if (text) sendKey(text); }).catch(() => {});
                  }
                }} className="toolbar-btn text-xs" title="Paste">Paste</button>
                <button onClick={() => {
                  const el = document.querySelector(`[data-session="${activeSession}"]`);
                  if (el) el.dispatchEvent(new CustomEvent('copy-screen'));
                }} className="toolbar-btn text-xs" title="Copy screen">Sel</button>
              </div>
              {/* Row 2: special keys */}
              <div className="px-2 py-1.5 flex items-center gap-1 border-b border-zinc-700">
                <button onClick={() => sendKey('\x03')} className="toolbar-btn text-xs" title="Ctrl-C">^C</button>
                <button onClick={() => sendKey('\x02')} className="toolbar-btn text-xs" title="Ctrl-B">^B</button>
                <button onClick={() => { sendKey('\x02'); setTimeout(() => sendKey('\x02'), 50); }} className="toolbar-btn text-xs" title="Ctrl-B Ctrl-B">^B^B</button>
                <button onClick={() => sendKey('\x0f')} className="toolbar-btn text-xs" title="Ctrl-O">^O</button>
                <button onClick={() => sendKey('\x1b')} className="toolbar-btn text-xs" title="Escape">Esc</button>
              </div>
            </>
          )}
          {/* Main row: voice | spacer | extra toggle | keyboard */}
          <div className="px-2 py-2 flex items-center gap-1">
            <VoiceButton conn={conn} session={activeSession} isMobile={true} />
            <div className="flex-1" />
            <button onClick={refreshTerminal} className="toolbar-btn" title="Refresh & scroll down">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
                <path strokeLinecap="round" d="M20.49 9A9 9 0 005.64 5.64L4 9m16 6l-1.64 3.36A9 9 0 014.51 15" />
              </svg>
            </button>
            <button
              onClick={() => setExtraKeys(!extraKeys)}
              className={`toolbar-btn ${extraKeys ? '!bg-zinc-600' : ''}`}
              title="Extra keys"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <path strokeLinecap="round" d="M8 6h.01M12 6h.01M16 6h.01M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
              </svg>
            </button>
            <button onClick={focusTerminal} className="toolbar-btn" title="Keyboard">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
              </svg>
            </button>
          </div>
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
