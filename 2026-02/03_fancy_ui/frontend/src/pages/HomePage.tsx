// Home page shown at "/".
// Shows a list of workspaces (unique folders with active agents) retrieved via `workspace.list`.
// Has a freestyle text input where user can type an absolute folder path and press Enter/button to open it.
// Later this text input will be replaced with a file browser / folder picker.
// Clicking a workspace or submitting a path navigates to `/<folder-path>` (full page navigation).

import { useState, useEffect, useSyncExternalStore } from 'react';
import { useAppState } from '../store';
import { send, onStatusChange, getUrl, setServerUrl, isConnected } from '../ws';

export function HomePage() {
  const { workspaces } = useAppState();
  const [folderInput, setFolderInput] = useState('');

  // Fetch workspaces on mount
  useEffect(() => {
    send({ type: 'workspace.list' });
    // Re-fetch on reconnect
    const interval = setInterval(() => send({ type: 'workspace.list' }), 5000);
    return () => clearInterval(interval);
  }, []);

  const openWorkspace = (folder: string) => {
    const normalized = folder.startsWith('/') ? folder : `/${folder}`;
    window.location.href = normalized;
  };

  const handleSubmit = () => {
    const trimmed = folderInput.trim();
    if (trimmed) openWorkspace(trimmed);
  };

  return (
    <div className="h-screen bg-zinc-900 text-zinc-100 flex flex-col">
      {/* Header */}
      <div className="flex items-center px-4 h-10 bg-zinc-800 border-b border-zinc-700 shrink-0">
        <span className="text-sm font-semibold text-zinc-300">Agent UI</span>
        <div className="flex-1" />
        <ServerIndicator />
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center overflow-y-auto pt-16">
        <div className="w-full max-w-lg px-4">
          <h1 className="text-2xl font-bold mb-6">Workspaces</h1>

          {/* Workspace list */}
          {workspaces.length > 0 ? (
            <div className="space-y-1 mb-6">
              {workspaces.map(w => (
                <button
                  key={w.folder}
                  onClick={() => openWorkspace(w.folder)}
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
          ) : (
            <div className="text-zinc-500 text-sm mb-6">No workspaces yet. Create an agent in a folder to get started.</div>
          )}

          {/* Folder input — will be replaced with file browser later */}
          <div className="border-t border-zinc-700 pt-4">
            <label className="text-xs text-zinc-400 uppercase tracking-wide font-semibold mb-2 block">
              Open folder
            </label>
            <div className="flex gap-2">
              <input
                value={folderInput}
                onChange={e => setFolderInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
                placeholder="/home/user/my-project"
                className="flex-1 bg-zinc-800 text-zinc-100 text-sm rounded-lg px-3 py-2 border border-zinc-600 focus:border-blue-500 outline-none font-mono placeholder-zinc-500"
              />
              <button
                onClick={handleSubmit}
                disabled={!folderInput.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-40"
              >
                Open
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function useConnectionStatus(): boolean {
  return useSyncExternalStore(
    (cb) => onStatusChange(() => cb()),
    () => isConnected(),
  );
}

function ServerIndicator() {
  const ok = useConnectionStatus();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(getUrl);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed) setServerUrl(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          onBlur={save}
          className="bg-zinc-700 text-zinc-200 text-xs rounded px-2 py-0.5 border border-zinc-600 outline-none focus:border-blue-500 w-56 font-mono"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => { setDraft(getUrl()); setEditing(true); }}
      className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      title="Click to edit server URL"
    >
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
      {getUrl().replace(/^wss?:\/\//, '')}
    </button>
  );
}
