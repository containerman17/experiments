// Agent chat view. Renders the ACP message log for one agent.
// ACP bootstrap (initialize + session/new) is handled by the backend.
// The frontend loads history, finds the sessionId, and renders chat.
// User messages are sent via `session/prompt`.
// The stop button sends `session/cancel`.

import { useState, useEffect, useRef, useMemo } from 'react';
import type { AgentState } from '../store';
import type { AgentLogEntry } from '../../../shared/types';
import { useDispatch } from '../store';
import { send } from '../ws';
import {
  sessionPromptRequest, sessionCancelNotification,
  sessionSetModeRequest, sessionSetConfigRequest,
  type RpcMessage, isResponse, isNotification,
} from '../acp';
import { useAcpState } from '../hooks/useAcpState';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function AgentChat({ agent }: { agent: AgentState }) {
  const [input, setInput] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [configMenuOpen, setConfigMenuOpen] = useState(false);
  const dispatch = useDispatch();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const configMenuRef = useRef<HTMLDivElement>(null);
  const { modes, currentMode, configOptions } = useAcpState(agent);

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };
  // Extract sessionId from log (backend sends history automatically on connect)
  useEffect(() => {
    if (agent.acpSessionId) return;
    for (const entry of agent.log) {
      if (entry.direction !== 'out') continue;
      const msg = entry.payload as RpcMessage;
      if (isResponse(msg) && msg.result?.sessionId) {
        dispatch({ type: 'AGENT_SESSION_CREATED', agentId: agent.info.id, acpSessionId: msg.result.sessionId });
        return;
      }
    }
  }, [agent.log.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect prompt completion → mark not busy
  useEffect(() => {
    if (!agent.busy) return;
    for (let i = agent.log.length - 1; i >= 0; i--) {
      const entry = agent.log[i];
      if (entry.direction !== 'out') continue;
      const msg = entry.payload as RpcMessage;
      if (isResponse(msg) && msg.result?.stopReason) {
        dispatch({ type: 'AGENT_BUSY', agentId: agent.info.id, busy: false });
        return;
      }
      break; // only check latest out entry
    }
  }, [agent.log.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agent.log.length]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || !agent.acpSessionId) return;
    send({
      type: 'agent.message',
      agentId: agent.info.id,
      payload: sessionPromptRequest(agent.acpSessionId, text),
    });
    dispatch({ type: 'AGENT_BUSY', agentId: agent.info.id, busy: true });
    setInput('');
    if (inputRef.current) { inputRef.current.style.height = 'auto'; }
  };

  const handleCancel = () => {
    if (!agent.acpSessionId) return;
    send({
      type: 'agent.message',
      agentId: agent.info.id,
      payload: sessionCancelNotification(agent.acpSessionId),
    });
  };

  const handleModeChange = (modeId: string) => {
    if (!agent.acpSessionId || modeId === currentMode) return;
    send({
      type: 'agent.message',
      agentId: agent.info.id,
      payload: sessionSetModeRequest(agent.acpSessionId, modeId),
    });
    setModeMenuOpen(false);
  };

  const handleConfigChange = (configId: string, value: string) => {
    if (!agent.acpSessionId) return;
    send({
      type: 'agent.message',
      agentId: agent.info.id,
      payload: sessionSetConfigRequest(agent.acpSessionId, configId, value),
    });
    send({ type: 'config.set_preference', agentType: agent.info.agentType, configId, value });
  };

  // Close dropdowns on outside click
  useEffect(() => {
    if (!modeMenuOpen && !configMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modeMenuOpen && modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) setModeMenuOpen(false);
      if (configMenuOpen && configMenuRef.current && !configMenuRef.current.contains(e.target as Node)) setConfigMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeMenuOpen, configMenuOpen]);

  const currentModeName = modes.find(m => m.id === currentMode)?.name || currentMode;

  // Accumulate log entries into logical chat messages
  const chatMessages = useMemo(() => accumulate(agent.log), [agent.log]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {agent.error && (
          <div className="mx-2 mt-2 px-3 py-2 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm font-mono whitespace-pre-wrap">
            {agent.error}
          </div>
        )}
        {!agent.error && chatMessages.length === 0 && agent.acpSessionId && (
          <div className="text-zinc-500 text-sm text-center mt-8">Agent ready. Send a message.</div>
        )}
        {!agent.error && !agent.acpSessionId && (
          <div className="text-zinc-500 text-sm text-center mt-8">Initializing agent...</div>
        )}

        {chatMessages.map((msg, i) => (
          <ChatMessage key={i} msg={msg} isLast={i === chatMessages.length - 1} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Loading indicator */}
      <div className={`shrink-0 h-px ${agent.busy ? 'loading-bar' : 'bg-zinc-700'}`} />

      {/* Input */}
      <div className="shrink-0 bg-zinc-800/50 px-3 py-2">
        <div className="flex items-end gap-2">
          {/* Mode switcher — upward dropdown */}
          {modes.length > 0 && (
            <div className="relative shrink-0" ref={modeMenuRef}>
              <button
                onClick={() => { setModeMenuOpen(v => !v); setConfigMenuOpen(false); }}
                className="px-2 py-1 text-xs rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                title={`Mode: ${currentModeName}`}
              >
                {currentModeName || 'Mode'}
              </button>
              {modeMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1 bg-zinc-700 border border-zinc-600 rounded shadow-lg z-50 min-w-[120px]">
                  {modes.map((m: any) => (
                    <button
                      key={m.id}
                      onClick={() => handleModeChange(m.id)}
                      className={`block w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        m.id === currentMode
                          ? 'bg-blue-600 text-white'
                          : 'text-zinc-200 hover:bg-zinc-600'
                      }`}
                    >
                      <div>{m.name || m.id}</div>
                      {m.description && <div className="text-[10px] text-zinc-400 mt-0.5">{m.description}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <textarea
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); autoResize(e.target); }}
            placeholder={agent.acpSessionId ? 'Message...' : 'Waiting for agent...'}
            disabled={!agent.acpSessionId}
            rows={1}
            className="flex-1 bg-transparent text-zinc-100 text-sm py-1.5 outline-none resize-none placeholder-zinc-500 disabled:opacity-50"
            style={{ maxHeight: '8rem' }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
          />

          {/* Config gear — upward popover */}
          {configOptions.length > 0 && (
            <div className="relative shrink-0" ref={configMenuRef}>
              <button
                onClick={() => { setConfigMenuOpen(v => !v); setModeMenuOpen(false); }}
                className="w-7 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-200 transition-colors"
                title="Settings"
              >
                <svg viewBox="0 0 20 20" className="w-4 h-4 fill-current">
                  <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                </svg>
              </button>
              {configMenuOpen && (
                <div className="absolute bottom-full right-0 mb-1 bg-zinc-700 border border-zinc-600 rounded shadow-lg z-50 min-w-[180px] p-2 space-y-2">
                  {configOptions.map((opt: any) => (
                    <div key={opt.id} className="text-xs">
                      <div className="text-zinc-400 mb-0.5">{opt.name}</div>
                      <select
                        value={opt.currentValue}
                        onChange={e => handleConfigChange(opt.id, e.target.value)}
                        className="w-full bg-zinc-800 text-zinc-200 text-xs rounded px-1.5 py-1 border border-zinc-600 outline-none"
                      >
                        {opt.options?.map((o: any) => (
                          <option key={o.value || o.name} value={o.value || o.name}>{o.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {agent.busy ? (
            <button onClick={handleCancel} className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-red-500/80 hover:bg-red-500 transition-colors cursor-pointer">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-white"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
            </button>
          ) : (
            <button onClick={handleSend} disabled={!agent.acpSessionId || !input.trim()} className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-blue-600 hover:bg-blue-500 transition-colors disabled:opacity-20 text-white text-sm cursor-pointer">
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Accumulate raw log entries into logical chat messages ---

type ChatMsg =
  | { kind: 'user'; text: string }
  | { kind: 'agent-text'; text: string }
  | { kind: 'agent-thought'; text: string }
  | { kind: 'tool-call'; tc: any }
  | { kind: 'plan'; entries: any[] }
  | { kind: 'mode-change'; modeId: string; modeName?: string }
;

function accumulate(log: AgentLogEntry[]): ChatMsg[] {
  const msgs: ChatMsg[] = [];
  let pendingText = '';
  let pendingThought = '';

  function flushText() {
    if (pendingText) { msgs.push({ kind: 'agent-text', text: pendingText }); pendingText = ''; }
  }
  function flushThought() {
    if (pendingThought) { msgs.push({ kind: 'agent-thought', text: pendingThought }); pendingThought = ''; }
  }

  for (const entry of log) {
    const msg = entry.payload as RpcMessage;

    // User prompt
    if (entry.direction === 'in' && msg.method === 'session/prompt') {
      flushText();
      flushThought();
      const prompt = msg.params?.prompt;
      const text = Array.isArray(prompt)
        ? prompt.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
        : '';
      if (text) msgs.push({ kind: 'user', text });
      continue;
    }

    // session/update notification
    if (entry.direction === 'out' && isNotification(msg) && msg.method === 'session/update') {
      const u = msg.params?.update;
      if (!u) continue;

      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          if (u.content?.type === 'text' && u.content.text) {
            flushThought();
            pendingText += u.content.text;
          }
          break;
        case 'agent_thought_chunk':
          if (u.content?.text) {
            pendingThought += u.content.text;
          }
          break;
        case 'tool_call':
          flushText();
          flushThought();
          msgs.push({ kind: 'tool-call', tc: u });
          break;
        case 'tool_call_update':
          // Update the last tool call if it matches
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].kind === 'tool-call' && (msgs[i] as any).tc.toolCallId === u.toolCallId) {
              (msgs[i] as any).tc = { ...(msgs[i] as any).tc, status: u.status };
              break;
            }
          }
          break;
        case 'plan':
          flushText();
          flushThought();
          if (u.entries?.length) msgs.push({ kind: 'plan', entries: u.entries });
          break;
        case 'current_mode_update':
          flushText();
          flushThought();
          msgs.push({ kind: 'mode-change', modeId: u.modeId, modeName: u.modeName });
          break;
        // available_commands_update, usage_update — skip
      }
      continue;
    }

    // current_mode_update notification (top-level, not inside session/update)
    if (entry.direction === 'out' && isNotification(msg) && msg.method === 'current_mode_update') {
      flushText();
      flushThought();
      msgs.push({ kind: 'mode-change', modeId: msg.params?.modeId, modeName: msg.params?.modeName });
      continue;
    }

    // session/prompt response — just flush pending text
    if (entry.direction === 'out' && isResponse(msg) && msg.result?.stopReason) {
      flushText();
      flushThought();
      continue;
    }
  }

  // Flush any remaining
  flushText();
  flushThought();

  return msgs;
}

// --- Render a single chat message ---

function ChatMessage({ msg, isLast }: { msg: ChatMsg; isLast: boolean }) {
  switch (msg.kind) {
    case 'user':
      return (
        <div className="flex justify-end my-3">
          <div className="max-w-[min(80%,48rem)] bg-blue-600 text-white rounded-lg px-2.5 py-1.5 text-sm whitespace-pre-wrap">
            {msg.text}
          </div>
        </div>
      );

    case 'agent-text':
      return (
        <div className="max-w-[48rem] text-zinc-200 text-sm prose prose-invert prose-sm mt-1.5">
          <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
        </div>
      );

    case 'agent-thought':
      return <div className="max-w-[48rem]"><ThoughtBlock text={msg.text} /></div>;

    case 'tool-call':
      return <div className="max-w-[48rem]"><ToolCallCard tc={msg.tc} /></div>;

    case 'plan':
      return <div className="max-w-[48rem]"><PlanCard entries={msg.entries} /></div>;

    case 'mode-change':
      return (
        <div className="text-xs text-zinc-500 italic my-1 px-2">
          Mode changed to <span className="text-zinc-300">{msg.modeName || msg.modeId}</span>
        </div>
      );
  }
}

function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.slice(0, 80).replace(/\n/g, ' ');

  return (
    <div className="border-l-2 border-zinc-700">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors w-full text-left"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>&#9656;</span>
        <span className="italic">
          {open ? 'Model thoughts' : `Model thoughts — ${preview}${text.length > 80 ? '...' : ''}`}
        </span>
      </button>
      {open && (
        <div className="text-xs text-zinc-500 italic px-2 py-0.5 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ tc }: { tc: any }) {
  const statusIcon = tc.status === 'completed' ? '\u2713' :
    tc.status === 'in_progress' ? '\u2022\u2022\u2022' :
    tc.status === 'failed' ? '\u2717' : '\u25CB';

  const statusColor = tc.status === 'completed' ? 'text-green-400' :
    tc.status === 'in_progress' ? 'text-blue-400' :
    tc.status === 'failed' ? 'text-red-400' : 'text-zinc-500';

  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-0.5 text-xs font-mono">
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-zinc-400">{tc.kind || 'tool'}</span>
        <span className="text-zinc-300 truncate">{tc.title}</span>
        {tc.locations?.map((loc: any, i: number) => (
          <span key={i} className="text-blue-400 text-[10px] ml-auto">
            {loc.path}{loc.line != null ? `:${loc.line}` : ''}
          </span>
        ))}
      </div>

      {/* Diff content */}
      {tc.content?.filter((c: any) => c.type === 'diff').map((d: any, i: number) => (
        <DiffBlock key={i} diff={d} />
      ))}
    </div>
  );
}

function PlanCard({ entries }: { entries: any[] }) {
  return (
    <div className="my-1.5 border-l-2 border-zinc-700 pl-2">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide mb-0.5">Plan</div>
      {entries.map((entry: any, i: number) => {
        const icon = entry.status === 'completed' ? '\u2713' :
          entry.status === 'in_progress' ? '\u25B6' : '\u25CB';
        const color = entry.status === 'completed' ? 'text-green-400' :
          entry.status === 'in_progress' ? 'text-blue-400' : 'text-zinc-500';
        return (
          <div key={i} className="flex items-start gap-1.5 text-xs">
            <span className={`${color} shrink-0 w-3 text-center`}>{icon}</span>
            <span className="text-zinc-300">{entry.content}</span>
          </div>
        );
      })}
    </div>
  );
}

function DiffBlock({ diff }: { diff: any }) {
  const patch = diff.patch || diff.after || '';
  if (!patch) return null;

  const lines = patch.split('\n').slice(0, 30);

  return (
    <div className="ml-2 rounded overflow-hidden text-[11px] font-mono">
      {diff.path && (
        <div className="px-2 py-0.5 bg-zinc-800 text-zinc-500 text-[10px]">{diff.path}</div>
      )}
      <div className="overflow-x-auto max-h-48">
        {lines.map((line: string, i: number) => {
          let bg = '';
          let color = 'text-zinc-400';
          if (line.startsWith('+')) { bg = 'bg-green-950'; color = 'text-green-300'; }
          else if (line.startsWith('-')) { bg = 'bg-red-950'; color = 'text-red-300'; }
          else if (line.startsWith('@@')) { color = 'text-blue-400'; }
          return (
            <div key={i} className={`px-2 ${bg}`}>
              <span className={`${color} whitespace-pre`}>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
