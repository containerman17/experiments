// Agent chat view. Renders the ACP message log for one agent.
// On mount, if the agent is not yet initialized, sends `initialize` then `session/new`.
// User messages are sent via `session/prompt`.
// Incoming `session/update` notifications are parsed to render:
//   - text content, tool calls (with status, kind, diffs), plan entries, thinking blocks
// Incoming `session/request_permission` requests are auto-granted (for now).
// The stop button sends `session/cancel`.

import { useState, useEffect, useRef } from 'react';
import type { AgentState } from '../store';
import { useDispatch } from '../store';
import { send } from '../ws';
import {
  initializeRequest, sessionNewRequest, sessionPromptRequest,
  sessionCancelNotification, permissionGrantResponse,
  type RpcMessage, isRequest, isResponse, isNotification,
} from '../acp';

export function AgentChat({ agent }: { agent: AgentState }) {
  const [input, setInput] = useState('');
  const dispatch = useDispatch();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  // Load history on mount if log is empty
  useEffect(() => {
    if (agent.log.length === 0) {
      send({ type: 'agent.history', agentId: agent.info.id, limit: 50 });
    }
  }, [agent.info.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bootstrap ACP: initialize → session/new
  useEffect(() => {
    if (!agent.acpInitialized && !initializedRef.current) {
      initializedRef.current = true;
      send({ type: 'agent.message', agentId: agent.info.id, payload: initializeRequest() });
    }
  }, [agent.info.id, agent.acpInitialized]);

  // Process incoming ACP messages for lifecycle management
  useEffect(() => {
    const lastEntry = agent.log[agent.log.length - 1];
    if (!lastEntry || lastEntry.direction !== 'out') return;

    const msg = lastEntry.payload as RpcMessage;

    // Handle initialize response → send session/new
    if (isResponse(msg) && agent.acpInitialized === false) {
      dispatch({ type: 'AGENT_INITIALIZED', agentId: agent.info.id });
      send({
        type: 'agent.message',
        agentId: agent.info.id,
        payload: sessionNewRequest(agent.info.folder),
      });
      return;
    }

    // Handle session/new response → extract sessionId
    if (isResponse(msg) && msg.result?.sessionId && !agent.acpSessionId) {
      dispatch({
        type: 'AGENT_SESSION_CREATED',
        agentId: agent.info.id,
        acpSessionId: msg.result.sessionId,
      });
      return;
    }

    // Handle session/prompt response → mark not busy
    if (isResponse(msg) && msg.result?.stopReason) {
      dispatch({ type: 'AGENT_BUSY', agentId: agent.info.id, busy: false });
      return;
    }

    // Handle session/request_permission → auto-grant
    if (isRequest(msg) && msg.method === 'session/request_permission') {
      send({
        type: 'agent.message',
        agentId: agent.info.id,
        payload: permissionGrantResponse(msg.id!),
      });
      return;
    }
  }, [agent.log.length]);

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
  };

  const handleCancel = () => {
    if (!agent.acpSessionId) return;
    send({
      type: 'agent.message',
      agentId: agent.info.id,
      payload: sessionCancelNotification(agent.acpSessionId),
    });
  };

  // Render the log as chat messages
  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {agent.error && (
          <div className="mx-2 mt-2 px-3 py-2 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm font-mono whitespace-pre-wrap">
            {agent.error}
          </div>
        )}
        {!agent.error && agent.log.length === 0 && agent.acpSessionId && (
          <div className="text-zinc-500 text-sm text-center mt-8">Agent ready. Send a message.</div>
        )}
        {!agent.error && !agent.acpSessionId && (
          <div className="text-zinc-500 text-sm text-center mt-8">Initializing agent...</div>
        )}

        {agent.log.map((entry, i) => (
          <LogEntry key={entry.id || i} entry={entry} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-zinc-700 p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={agent.acpSessionId ? 'Send a message...' : 'Waiting for agent...'}
            disabled={!agent.acpSessionId}
            rows={2}
            className="flex-1 bg-zinc-800 text-zinc-100 text-sm rounded-lg px-3 py-2 border border-zinc-600 focus:border-blue-500 outline-none resize-none placeholder-zinc-500 disabled:opacity-50"
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
          />
          {agent.busy ? (
            <button onClick={handleCancel} className="self-end px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors">
              Stop
            </button>
          ) : (
            <button onClick={handleSend} disabled={!agent.acpSessionId} className="self-end px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-40">
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Render a single log entry ---

import type { AgentLogEntry } from '../../../shared/types';

function LogEntry({ entry }: { entry: AgentLogEntry }) {
  const msg = entry.payload as RpcMessage;

  // User prompt (direction: 'in', method: session/prompt)
  if (entry.direction === 'in' && msg.method === 'session/prompt') {
    const text = msg.params?.message?.content?.text || msg.params?.message?.content || '';
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-blue-600 text-white rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  // session/update notification from agent
  if (entry.direction === 'out' && isNotification(msg) && msg.method === 'session/update') {
    return <SessionUpdate params={msg.params} />;
  }

  // session/prompt response (stop reason)
  if (entry.direction === 'out' && isResponse(msg) && msg.result?.stopReason) {
    const reason = msg.result.stopReason;
    const label = reason === 'end_turn' ? 'Done' :
      reason === 'cancelled' ? 'Cancelled' :
      reason === 'max_tokens' ? 'Token limit reached' :
      reason === 'refusal' ? 'Refused' : reason;
    return (
      <div className="text-center text-xs text-zinc-500 py-1">--- {label} ---</div>
    );
  }

  // Hide lifecycle messages (initialize, session/new, etc.)
  if (entry.direction === 'in' && (msg.method === 'initialize' || msg.method === 'session/new')) return null;
  if (entry.direction === 'out' && isResponse(msg) && !msg.result?.stopReason) return null;
  if (entry.direction === 'in' && isResponse(msg)) return null; // permission responses

  // Fallback: show raw for debugging
  return null;
}

// --- Render session/update content ---

function SessionUpdate({ params }: { params: any }) {
  if (!params) return null;

  return (
    <div className="space-y-1">
      {/* Text content */}
      {params.message?.content && (
        <AgentTextContent content={params.message.content} />
      )}

      {/* Thinking */}
      {params.thinking && (
        <div className="text-xs text-zinc-500 italic px-3 py-1 border-l-2 border-zinc-700">
          {params.thinking}
        </div>
      )}

      {/* Tool calls */}
      {params.toolCalls?.map((tc: any) => (
        <ToolCallCard key={tc.toolCallId} tc={tc} />
      ))}

      {/* Plan (shown in sidebar, but also inline if present) */}
    </div>
  );
}

function AgentTextContent({ content }: { content: any }) {
  // content can be string or { type: 'text', text: '...' } or array
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (content?.text) {
    text = content.text;
  } else if (Array.isArray(content)) {
    text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  }

  if (!text) return null;

  return (
    <div className="max-w-[80%] bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
      {text}
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
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 px-2.5 py-1 bg-zinc-850 border border-zinc-700 rounded text-xs font-mono">
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-zinc-400">{tc.kind || 'tool'}</span>
        <span className="text-zinc-300 truncate">{tc.title}</span>
        {tc.locations?.map((loc: any, i: number) => (
          <span key={i} className="text-blue-400 text-[10px] ml-auto">
            {loc.path}{loc.line != null ? `:${loc.line}` : ''}
          </span>
        ))}
      </div>

      {/* Diff */}
      {tc.content?.filter((c: any) => c.type === 'diff').map((d: any, i: number) => (
        <DiffBlock key={i} diff={d} />
      ))}
    </div>
  );
}

function DiffBlock({ diff }: { diff: any }) {
  const patch = diff.patch || diff.after || '';
  if (!patch) return null;

  const lines = patch.split('\n').slice(0, 30);

  return (
    <div className="ml-2 border border-zinc-700 rounded overflow-hidden text-[11px] font-mono">
      {diff.path && (
        <div className="px-2 py-0.5 bg-zinc-800 text-zinc-500 text-[10px] border-b border-zinc-700">{diff.path}</div>
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
