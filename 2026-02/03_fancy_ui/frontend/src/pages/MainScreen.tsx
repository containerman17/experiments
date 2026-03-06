// Main screen: shows all backends and their workspaces.
// Opens temporary connections to each backend to fetch workspace lists.
// Connections are closed on unmount or when entering a workspace.

import { useState, useEffect, useRef } from 'react';
import type { BackendEntry } from '../backends';
import { loadBackends, saveBackends, addBackend, removeBackend } from '../backends';
import { createConnection, type WsConnection } from '../ws';
import type { WorkspaceInfo } from '../../../shared/types';
import type { Screen } from '../App';

interface BackendState {
  workspaces: WorkspaceInfo[];
  connected: boolean;
}

export function MainScreen({ setScreen }: { setScreen: (s: Screen) => void }) {
  const [backends, setBackends] = useState<BackendEntry[]>(loadBackends);
  const [backendStates, setBackendStates] = useState<Record<string, BackendState>>({});
  const [newTitle, setNewTitle] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [folderInputs, setFolderInputs] = useState<Record<string, string>>({});
  const connectionsRef = useRef<Map<string, WsConnection>>(new Map());

  // Manage connections for all backends
  useEffect(() => {
    const conns = connectionsRef.current;

    // Close connections for removed backends
    for (const [id, conn] of conns) {
      if (!backends.find(b => b.id === id)) {
        conn.close();
        conns.delete(id);
      }
    }

    // Create connections for new backends
    for (const backend of backends) {
      if (conns.has(backend.id)) continue;
      const conn = createConnection(backend.url);
      conns.set(backend.id, conn);

      conn.onStatusChange((connected) => {
        setBackendStates(prev => ({
          ...prev,
          [backend.id]: { ...prev[backend.id], connected, workspaces: prev[backend.id]?.workspaces || [] },
        }));
        if (connected) {
          conn.send({ type: 'workspace.list' });
        }
      });

      conn.subscribe((msg) => {
        if (msg.type === 'workspace.list.result') {
          setBackendStates(prev => ({
            ...prev,
            [backend.id]: { ...prev[backend.id], connected: prev[backend.id]?.connected ?? false, workspaces: msg.workspaces },
          }));
        }
      });
    }

    return () => {
      for (const conn of conns.values()) conn.close();
      conns.clear();
    };
  }, [backends]);

  const handleAddBackend = () => {
    const title = newTitle.trim() || 'Server';
    const url = newUrl.trim();
    if (!url) return;
    const entry = addBackend(title, url);
    setBackends(prev => [...prev, entry]);
    setNewTitle('');
    setNewUrl('');
  };

  const handleRemoveBackend = (id: string) => {
    if (!confirm('Remove this backend?')) return;
    removeBackend(id);
    setBackends(prev => prev.filter(b => b.id !== id));
    setBackendStates(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const openWorkspace = (backend: BackendEntry, folder: string) => {
    setScreen({ kind: 'workspace', backendId: backend.id, backendUrl: backend.url, folder });
  };

  return (
    <div className="h-dvh bg-zinc-900 text-zinc-100 flex flex-col">
      {/* Header */}
      <div className="flex items-center px-4 h-10 bg-zinc-800 border-b border-zinc-700 shrink-0">
        <span className="text-sm font-semibold text-zinc-300">Agent UI</span>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center overflow-y-auto pt-8 md:pt-16">
        <div className="w-full max-w-lg px-4 pb-8">

          {backends.length === 0 && (
            <div className="text-zinc-500 text-sm mb-6">No backends configured. Add one below to get started.</div>
          )}

          {/* Backend cards */}
          {backends.map(backend => {
            const bs = backendStates[backend.id];
            const workspaces = bs?.workspaces || [];
            const connected = bs?.connected ?? false;
            const folderInput = folderInputs[backend.id] || '';

            return (
              <div key={backend.id} className="mb-6">
                {/* Backend header */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-lg font-semibold text-zinc-200">{backend.title}</span>
                  <span className="text-xs text-zinc-500 font-mono">{backend.url.replace(/^wss?:\/\//, '')}</span>
                  <span className="flex-1" />
                  <button
                    onClick={() => handleRemoveBackend(backend.id)}
                    className="text-zinc-500 hover:text-red-400 text-sm px-1 transition-colors"
                    title="Remove backend"
                  >
                    &#128465;
                  </button>
                </div>

                {/* Workspace list */}
                {workspaces.length > 0 ? (
                  <div className="space-y-1 mb-3">
                    {workspaces.map(w => (
                      <button
                        key={w.folder}
                        onClick={() => openWorkspace(backend, w.folder)}
                        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg hover:bg-zinc-750 transition-colors text-left"
                      >
                        <div>
                          <div className="text-zinc-100 font-medium">{w.folder.split('/').pop()}</div>
                          <div className="text-zinc-500 text-xs font-mono">{w.folder}</div>
                        </div>
                        <span className="text-zinc-500 text-xs">
                          {w.agentCount} agent{w.agentCount !== 1 ? 's' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : connected ? (
                  <div className="text-zinc-500 text-xs mb-3 ml-4">No workspaces yet.</div>
                ) : (
                  <div className="text-zinc-500 text-xs mb-3 ml-4">Connecting...</div>
                )}

                {/* Open folder input */}
                <div className="flex gap-2 ml-4">
                  <input
                    value={folderInput}
                    onChange={e => setFolderInputs(prev => ({ ...prev, [backend.id]: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && folderInput.trim()) openWorkspace(backend, folderInput.trim());
                    }}
                    placeholder="/home/user/my-project"
                    className="flex-1 bg-zinc-800 text-zinc-100 text-sm rounded-lg px-3 py-2 border border-zinc-600 focus:border-blue-500 outline-none font-mono placeholder-zinc-500"
                  />
                  <button
                    onClick={() => { if (folderInput.trim()) openWorkspace(backend, folderInput.trim()); }}
                    disabled={!folderInput.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-40"
                  >
                    Open
                  </button>
                </div>
              </div>
            );
          })}

          {/* Add backend form */}
          <div className="border-t border-zinc-700 pt-4 mt-4">
            <label className="text-xs text-zinc-400 uppercase tracking-wide font-semibold mb-2 block">
              Add Backend
            </label>
            <div className="flex gap-2">
              <input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="My Server"
                className="w-32 bg-zinc-800 text-zinc-100 text-sm rounded-lg px-3 py-2 border border-zinc-600 focus:border-blue-500 outline-none placeholder-zinc-500"
              />
              <input
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddBackend(); }}
                placeholder="ws://localhost:8080"
                className="flex-1 bg-zinc-800 text-zinc-100 text-sm rounded-lg px-3 py-2 border border-zinc-600 focus:border-blue-500 outline-none font-mono placeholder-zinc-500"
              />
              <button
                onClick={handleAddBackend}
                disabled={!newUrl.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
