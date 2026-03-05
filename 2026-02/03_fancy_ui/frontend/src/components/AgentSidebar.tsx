// Right sidebar for the active agent.
// Parses the agent's ACP log to extract and display:
//   - Plan entries (from the latest session/update with plan data)
//   - Available modes (from session/new response or current_mode_update)
//   - Config options (from session/new response or config_options_update)
//   - Agent info (type, session ID, status)
// Mode changes send `session/set_mode` via ACP.
// Config changes send `session/set_config_option` via ACP.

import { useMemo } from 'react';
import type { AgentState } from '../store';
import { useDispatch } from '../store';
import { send } from '../ws';
import { sessionSetModeRequest, sessionSetConfigRequest, type RpcMessage, isResponse, isNotification } from '../acp';

export function AgentSidebar({ agent }: { agent: AgentState; onDelete?: () => void }) {
  const dispatch = useDispatch();
  // Extract latest plan, modes, configOptions from ACP log
  const { plan, modes, currentMode, configOptions } = useMemo(() => {
    let plan: any[] = [];
    let modes: any[] = [];
    let currentMode = '';
    let configOptions: any[] = [];

    for (const entry of agent.log) {
      if (entry.direction !== 'out') continue;
      const msg = entry.payload as RpcMessage;

      // session/new response
      if (isResponse(msg) && msg.result?.sessionId) {
        modes = msg.result.availableModes || [];
        currentMode = msg.result.currentModeId || '';
        configOptions = msg.result.configOptions || [];
      }

      // session/update with plan
      if (isNotification(msg) && msg.method === 'session/update' && msg.params?.plan) {
        plan = msg.params.plan;
      }

      // current_mode_update
      if (isNotification(msg) && msg.method === 'current_mode_update') {
        currentMode = msg.params?.modeId || currentMode;
      }

      // config_options_update
      if (isNotification(msg) && msg.method === 'config_options_update') {
        configOptions = msg.params?.configOptions || configOptions;
      }
    }

    return { plan, modes, currentMode, configOptions };
  }, [agent.log]);

  const handleModeChange = (modeId: string) => {
    if (!agent.acpSessionId) return;
    send({
      type: 'agent.message',
      agentId: agent.info.id,
      payload: sessionSetModeRequest(agent.acpSessionId, modeId),
    });
  };

  const handleConfigChange = (optionId: string, value: string) => {
    if (!agent.acpSessionId) return;
    send({
      type: 'agent.message',
      agentId: agent.info.id,
      payload: sessionSetConfigRequest(agent.acpSessionId, optionId, value),
    });
  };

  return (
    <div className="w-[220px] bg-zinc-800 border-l border-zinc-700 shrink-0 flex flex-col overflow-y-auto text-sm">
      {/* Agent info */}
      <div className="border-b border-zinc-700 px-3 py-2">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1">Agent</h3>
        <div className="text-xs space-y-0.5">
          <div><span className="text-zinc-500">Type:</span> <span className="text-zinc-300">{agent.info.agentType}</span></div>
          <div><span className="text-zinc-500">Status:</span> <span className="text-zinc-300">{agent.busy ? 'working...' : 'idle'}</span></div>
          {agent.acpSessionId && (
            <div className="text-zinc-500 text-[10px] font-mono truncate" title={agent.acpSessionId}>
              {agent.acpSessionId}
            </div>
          )}
        </div>
      </div>

      {/* Mode */}
      {modes.length > 0 && (
        <div className="border-b border-zinc-700 px-3 py-2">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1">Mode</h3>
          <select
            value={currentMode}
            onChange={e => handleModeChange(e.target.value)}
            className="w-full bg-zinc-700 text-zinc-300 text-xs rounded px-1.5 py-1 border border-zinc-600 outline-none focus:border-blue-500"
          >
            {modes.map((m: any) => (
              <option key={m.id} value={m.id}>{m.name || m.id}</option>
            ))}
          </select>
        </div>
      )}

      {/* Config options */}
      {configOptions.length > 0 && (
        <div className="border-b border-zinc-700 px-3 py-2">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1">Options</h3>
          <div className="space-y-1.5">
            {configOptions.map((opt: any) => (
              <div key={opt.id} className="text-xs">
                <span className="text-zinc-500">{opt.name}:</span>
                <select
                  value={opt.currentValue}
                  onChange={e => handleConfigChange(opt.id, e.target.value)}
                  className="ml-1 bg-zinc-700 text-zinc-300 text-xs rounded px-1 py-0.5 border border-zinc-600 outline-none"
                >
                  {opt.options?.map((o: any) => (
                    <option key={o.value || o.name} value={o.value || o.name}>{o.name}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Plan */}
      {plan.length > 0 && (
        <div className="border-b border-zinc-700 px-3 py-2">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1">Plan</h3>
          <div className="space-y-1">
            {plan.map((entry: any, i: number) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className={`mt-0.5 w-3 h-3 rounded-full shrink-0 border ${
                  entry.status === 'completed' ? 'bg-green-500 border-green-500' :
                  entry.status === 'in_progress' ? 'bg-blue-500 border-blue-500' :
                  'border-zinc-500'
                }`} />
                <span className="text-zinc-300 text-xs">{entry.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Delete */}
      <div className="mt-auto px-3 py-2 border-t border-zinc-700">
        <button
          onClick={() => {
            if (!confirm('Delete this agent? This will kill the process and archive it.')) return;
            send({ type: 'agent.delete', agentId: agent.info.id });
            dispatch({ type: 'CLOSE_TAB', tabId: `tab-${agent.info.id}` });
          }}
          className="w-full px-3 py-1.5 text-xs text-red-400 border border-zinc-600 rounded hover:bg-red-950 hover:border-red-800 transition-colors"
        >
          Delete Agent
        </button>
      </div>
    </div>
  );
}
