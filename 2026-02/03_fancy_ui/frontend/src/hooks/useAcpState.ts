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

      // session/set_config_option response
      if (isResponse(msg) && msg.result?.configOptions) {
        configOptions = msg.result.configOptions;
      }
    }

    return { plan, modes, currentMode, configOptions };
  }, [agent.log]);
}
