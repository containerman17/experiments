// Extract modes, config options, plan from an agent's ACP log.
// Used by AgentChat input bar (mode switcher, config popover).

import { useMemo } from 'react';
import type { AgentState } from '../store';
import type { RpcMessage } from '../acp';
import { isResponse, isNotification } from '../acp';

export interface AcpMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: { name: string; value?: string; description?: string }[];
}

export interface AcpState {
  plan: any[];
  modes: AcpMode[];
  currentMode: string;
  configOptions: AcpConfigOption[];
}

export function useAcpState(agent: AgentState): AcpState {
  return useMemo(() => {
    // Start with persisted ACP state from backend (survives page refresh)
    const persisted = agent.info.acpState;
    let plan: any[] = [];
    let modes: AcpMode[] = persisted?.modes || [];
    let currentMode = persisted?.currentModeId || '';
    let configOptions: AcpConfigOption[] = (persisted?.configOptions || []) as AcpConfigOption[];

    // Track outgoing request IDs to methods/params for matching responses
    const pendingRequests = new Map<number, { method: string; params?: any }>();

    for (const entry of agent.log) {
      const msg = entry.payload as RpcMessage;

      // Track outgoing requests (direction 'in' = client→agent)
      if (entry.direction === 'in' && msg.method && msg.id !== undefined) {
        pendingRequests.set(msg.id, { method: msg.method, params: msg.params });
      }

      if (entry.direction !== 'out') continue;

      // session/new response
      // Gemini nests modes under result.modes.{availableModes,currentModeId} instead of flat
      if (isResponse(msg) && msg.result?.sessionId) {
        modes = msg.result.availableModes || msg.result.modes?.availableModes || [];
        currentMode = msg.result.currentModeId || msg.result.modes?.currentModeId || '';
        configOptions = msg.result.configOptions || [];
      }

      // session/update with plan
      if (isNotification(msg) && msg.method === 'session/update') {
        const u = msg.params?.update;
        if (u?.sessionUpdate === 'plan' && u.entries) {
          plan = u.entries;
        }
      }

      // current_mode_update
      if (isNotification(msg) && msg.method === 'current_mode_update') {
        currentMode = msg.params?.modeId || currentMode;
      }

      // config_options_update
      if (isNotification(msg) && msg.method === 'config_options_update') {
        configOptions = msg.params?.configOptions || configOptions;
      }

      // Match responses to their requests by JSON-RPC ID.
      // Gemini returns empty {} for session/set_mode, so we correlate with the
      // outgoing request to recover the modeId. Claude includes currentModeId in
      // the response, which takes priority via the fallback chain.
      if (isResponse(msg) && msg.id !== undefined) {
        const req = pendingRequests.get(msg.id);

        if (req?.method === 'session/set_mode' && !msg.error) {
          currentMode = msg.result?.currentModeId || req.params?.modeId || currentMode;
        }

        // session/set_config_option response
        if (msg.result?.configOptions) {
          configOptions = msg.result.configOptions;
        }
      }
    }

    return { plan, modes, currentMode, configOptions };
  }, [agent.log, agent.info.acpState]);
}
