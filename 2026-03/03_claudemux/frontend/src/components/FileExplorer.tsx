import { useState, useEffect, useCallback } from 'react';
import type { Connection } from '../ws';
import type { FileEntry } from '../types';

interface Props {
  conn: Connection;
  onSessionCreated?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function FileExplorer({ conn, onSessionCreated }: Props) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [sessionDirs, setSessionDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const unsub = conn.subscribe(msg => {
      if (msg.type === 'files.list') {
        setEntries(msg.entries);
        setCurrentPath(msg.path);
        setLoading(false);
        setError(null);
      }
      if (msg.type === 'files.sessionDirs') {
        setSessionDirs(msg.dirs);
      }
      if (msg.type === 'files.error') {
        setError(msg.message);
        setLoading(false);
      }
    });

    // Request session dirs on mount by listing home
    conn.send({ type: 'files.list', path: '/home/claude' });

    return unsub;
  }, [conn]);

  const navigate = useCallback((path: string) => {
    setLoading(true);
    setError(null);
    conn.send({ type: 'files.list', path });
  }, [conn]);

  const goUp = useCallback(() => {
    if (!currentPath || currentPath === '/') return;
    const parent = currentPath.replace(/\/[^/]+$/, '') || '/';
    navigate(parent);
  }, [currentPath, navigate]);

  const handleMkdir = useCallback(() => {
    if (!currentPath) return;
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    conn.send({ type: 'files.mkdir', path: `${currentPath}/${name.trim()}` });
    // Refresh after a short delay
    setTimeout(() => navigate(currentPath), 300);
  }, [currentPath, conn, navigate]);

  const handleCreateSession = useCallback(() => {
    if (!currentPath) return;
    conn.send({ type: 'files.createSession', path: currentPath });
    onSessionCreated?.();
  }, [currentPath, conn, onSessionCreated]);

  const handleCopyPath = useCallback((filePath: string) => {
    navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, []);

  // Breadcrumbs
  const breadcrumbs = currentPath ? currentPath.split('/').filter(Boolean) : [];

  // Initial "jump to" view
  if (!currentPath) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-400">
        <span className="animate-pulse">Loading...</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-zinc-900 text-zinc-200 overflow-hidden">
      {/* Copied feedback */}
      {copied && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-green-600 text-white px-4 py-2 rounded shadow-lg text-sm">
          Copied!
        </div>
      )}

      {/* Header: breadcrumbs + actions */}
      <div className="shrink-0 border-b border-zinc-700 px-3 py-2 flex flex-col gap-2">
        {/* Breadcrumb row */}
        <div className="flex items-center gap-1 overflow-x-auto text-sm">
          <button
            onClick={goUp}
            className="shrink-0 p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Go up"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={() => navigate('/')}
            className="shrink-0 text-zinc-400 hover:text-zinc-200 px-1 transition-colors"
          >
            /
          </button>
          {breadcrumbs.map((seg, i) => (
            <span key={i} className="flex items-center shrink-0">
              <button
                onClick={() => navigate('/' + breadcrumbs.slice(0, i + 1).join('/'))}
                className="text-zinc-400 hover:text-zinc-200 px-1 transition-colors truncate max-w-[150px]"
              >
                {seg}
              </button>
              {i < breadcrumbs.length - 1 && <span className="text-zinc-600">/</span>}
            </span>
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleMkdir}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-zinc-800 border border-zinc-600 rounded hover:border-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
            New Folder
          </button>
          <button
            onClick={handleCreateSession}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" d="M4 17l6-6-6-6M12 19h8" />
            </svg>
            New Session Here
          </button>
          <button
            onClick={() => handleCopyPath(currentPath!)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-zinc-800 border border-zinc-600 rounded hover:border-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            Copy Path
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="shrink-0 px-3 py-2 bg-red-900/30 text-red-400 text-sm border-b border-zinc-700">
          {error}
        </div>
      )}

      {/* Jump-to section */}
      {sessionDirs.length > 0 && (
        <div className="shrink-0 border-b border-zinc-700 px-3 py-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Jump to</div>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => navigate('/home/claude')}
              className="px-3 py-1.5 text-xs bg-zinc-800 border border-zinc-600 rounded hover:border-zinc-400 hover:text-zinc-100 transition-colors"
            >
              ~ Home
            </button>
            {sessionDirs.map(dir => (
              <button
                key={dir}
                onClick={() => navigate(dir)}
                className={`px-3 py-1.5 text-xs bg-zinc-800 border rounded transition-colors truncate max-w-[200px] ${
                  dir === currentPath
                    ? 'border-blue-500 text-blue-400'
                    : 'border-zinc-600 hover:border-zinc-400 hover:text-zinc-100'
                }`}
                title={dir}
              >
                {dir.split('/').slice(-2).join('/')}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8 text-zinc-500">
            <span className="animate-pulse">Loading...</span>
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-zinc-500 text-sm">
            Empty directory
          </div>
        )}
        {!loading && entries.map(entry => (
          <button
            key={entry.name}
            onClick={() => {
              if (entry.isDir) {
                navigate(`${currentPath === '/' ? '' : currentPath}/${entry.name}`);
              } else {
                handleCopyPath(`${currentPath === '/' ? '' : currentPath}/${entry.name}`);
              }
            }}
            className="w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-zinc-800 transition-colors border-b border-zinc-800/50 cursor-pointer"
          >
            {/* Icon */}
            {entry.isDir ? (
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 shrink-0 text-blue-400">
                <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 shrink-0 text-zinc-500">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
            )}
            {/* Name + size */}
            <div className="flex-1 min-w-0">
              <div className={`text-sm truncate ${entry.isDir ? 'text-zinc-200' : 'text-zinc-400'}`}>
                {entry.name}
              </div>
            </div>
            {!entry.isDir && (
              <span className="shrink-0 text-xs text-zinc-600">{formatSize(entry.size)}</span>
            )}
            {entry.isDir && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0 text-zinc-600">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
