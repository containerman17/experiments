// ACP (Agent Client Protocol) JSON-RPC helpers.
// Builds JSON-RPC 2.0 requests/responses and parses notifications.
// These are the raw payloads sent inside `agent.message` and received from `agent.output`.
// See spec.md for the full ACP specification.

let nextId = 1;

// --- Build JSON-RPC requests (client → agent) ---

export function rpcRequest(method: string, params: Record<string, unknown> = {}): { jsonrpc: '2.0'; id: number; method: string; params: Record<string, unknown> } {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

export function rpcNotification(method: string, params: Record<string, unknown> = {}): { jsonrpc: '2.0'; method: string; params: Record<string, unknown> } {
  return { jsonrpc: '2.0', method, params };
}

export function rpcResponse(id: number, result: unknown): { jsonrpc: '2.0'; id: number; result: unknown } {
  return { jsonrpc: '2.0', id, result };
}

// --- ACP request builders ---

export function initializeRequest() {
  return rpcRequest('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'agent-ui', title: 'Agent UI', version: '0.1.0' },
    capabilities: {
      readTextFile: false,  // TODO: implement later
      writeTextFile: false, // TODO: implement later
      terminal: false,      // TODO: implement later
    },
  });
}

export function sessionNewRequest(workingDirectory: string) {
  return rpcRequest('session/new', { workingDirectory });
}

export function sessionPromptRequest(sessionId: string, text: string) {
  return rpcRequest('session/prompt', {
    sessionId,
    message: {
      role: 'user',
      content: { type: 'text', text },
    },
  });
}

export function sessionCancelNotification(sessionId: string) {
  return rpcNotification('session/cancel', { sessionId });
}

export function sessionSetModeRequest(sessionId: string, modeId: string) {
  return rpcRequest('session/set_mode', { sessionId, modeId });
}

export function sessionSetConfigRequest(sessionId: string, configOptionId: string, value: string) {
  return rpcRequest('session/set_config_option', { sessionId, configOptionId, value });
}

// --- Auto-grant permission (for now) ---

export function permissionGrantResponse(requestId: number) {
  return rpcResponse(requestId, { outcome: 'selected', selectedIndex: 0 });
}

// --- Parse incoming JSON-RPC ---

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export function isNotification(msg: RpcMessage): boolean {
  return msg.method !== undefined && msg.id === undefined;
}

export function isRequest(msg: RpcMessage): boolean {
  return msg.method !== undefined && msg.id !== undefined;
}

export function isResponse(msg: RpcMessage): boolean {
  return msg.method === undefined && msg.id !== undefined;
}
