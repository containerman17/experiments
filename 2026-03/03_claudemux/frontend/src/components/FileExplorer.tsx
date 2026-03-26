import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { Connection } from '../ws';
import type { FileEntry, FilePreview } from '../types';

interface Props {
  conn: Connection;
  onSessionCreated?: () => void;
  initialPath?: string;
}

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('go', go);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('makefile', makefile);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function FileExplorer({ conn, onSessionCreated, initialPath }: Props) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const lastInitialPathRef = useRef<string | undefined>(initialPath);

  useEffect(() => {
    const unsub = conn.subscribe(msg => {
      if (msg.type === 'files.list') {
        setEntries(msg.entries);
        setCurrentPath(msg.path);
        setLoading(false);
        setError(null);
      }
      if (msg.type === 'files.error') {
        setError(msg.message);
        setLoading(false);
        setPreviewLoading(false);
      }
      if (msg.type === 'files.preview') {
        setPreview(msg);
        setPreviewLoading(false);
        setError(null);
      }
    });

    // Request session dirs on mount by listing home
    conn.send({ type: 'files.list', path: initialPath || '/home/claude' });

    return unsub;
  }, [conn, initialPath]);

  const navigate = useCallback((path: string) => {
    setLoading(true);
    setError(null);
    setPreview(null);
    setPreviewLoading(false);
    conn.send({ type: 'files.list', path });
  }, [conn]);

  useEffect(() => {
    if (!initialPath || initialPath === lastInitialPathRef.current) return;
    lastInitialPathRef.current = initialPath;
    navigate(initialPath);
  }, [initialPath, navigate]);

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

  const handlePreview = useCallback((filePath: string) => {
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    conn.send({ type: 'files.preview', path: filePath });
  }, [conn]);

  const previewHtml = useMemo(() => {
    if (!preview) return '';
    try {
      return hljs.highlight(preview.content, { language: preview.language, ignoreIllegals: true }).value;
    } catch {
      return hljs.highlightAuto(preview.content).value;
    }
  }, [preview]);

  // Breadcrumbs
  const breadcrumbs = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const previewName = preview?.path.split('/').pop() || null;

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
          {preview ? (
            <button
              onClick={() => setPreview(null)}
              className="shrink-0 p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Back to file list"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          ) : (
            <button
              onClick={goUp}
              className="shrink-0 p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Go up"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
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
          {previewName && (
            <>
              <span className="text-zinc-600">/</span>
              <span className="text-zinc-200 px-1 shrink-0">{previewName}</span>
              <button
                onClick={() => handleCopyPath(preview.path)}
                className="shrink-0 p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 transition-colors"
                title="Copy file path"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Action buttons */}
        {!preview && (
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
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="shrink-0 px-3 py-2 bg-red-900/30 text-red-400 text-sm border-b border-zinc-700">
          {error}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {previewLoading && (
          <div className="flex items-center justify-center py-8 text-zinc-500">
            <span className="animate-pulse">Loading preview...</span>
          </div>
        )}
        {!previewLoading && preview && (
          <div className="h-full overflow-auto">
            <pre className="w-full p-4 text-[13px] leading-6 text-zinc-200 whitespace-pre-wrap break-words">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </pre>
          </div>
        )}
        {!previewLoading && !preview && loading && (
          <div className="flex items-center justify-center py-8 text-zinc-500">
            <span className="animate-pulse">Loading...</span>
          </div>
        )}
        {!previewLoading && !preview && !loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-zinc-500 text-sm">
            Empty directory
          </div>
        )}
        {!previewLoading && !preview && !loading && entries.map(entry => (
          <div
            key={entry.name}
            role="button"
            tabIndex={0}
            onClick={() => {
              const entryPath = `${currentPath === '/' ? '' : currentPath}/${entry.name}`;
              if (entry.isDir) {
                navigate(entryPath);
              } else {
                handlePreview(entryPath);
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              const entryPath = `${currentPath === '/' ? '' : currentPath}/${entry.name}`;
              if (entry.isDir) {
                navigate(entryPath);
              } else {
                handlePreview(entryPath);
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
            <button
              onClick={(e) => {
                e.stopPropagation();
                const entryPath = `${currentPath === '/' ? '' : currentPath}/${entry.name}`;
                handleCopyPath(entryPath);
              }}
              className="shrink-0 p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
              title="Copy path"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
