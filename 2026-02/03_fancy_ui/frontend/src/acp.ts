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
    clientCapabilities: {
      fs: {
        readTextFile: false,  // TODO: implement later
        writeTextFile: false, // TODO: implement later
      },
    },
  });
}

export function sessionNewRequest(cwd: string) {
  return rpcRequest('session/new', { cwd, mcpServers: [] });
}

export interface ImageAttachment {
  mediaType: string;
  base64: string;
}

export function sessionPromptRequest(sessionId: string, text: string, images?: ImageAttachment[]) {
  const prompt: any[] = [];
  if (images?.length) {
    for (const img of images) {
      prompt.push({ type: 'image', data: img.base64, mimeType: img.mediaType });
    }
  }
  prompt.push({ type: 'text', text });
  return rpcRequest('session/prompt', { sessionId, prompt });
}

export function sessionCancelNotification(sessionId: string) {
  return rpcNotification('session/cancel', { sessionId });
}

export function sessionSetModeRequest(sessionId: string, modeId: string) {
  return rpcRequest('session/set_mode', { sessionId, modeId });
}

export function sessionSetConfigRequest(sessionId: string, configId: string, value: string) {
  return rpcRequest('session/set_config_option', { sessionId, configId, value });
}

// --- Auto-grant permission (for now) ---

export function permissionGrantResponse(requestId: number, options?: any[]) {
  const firstOptionId = options?.[0]?.optionId || '';
  return rpcResponse(requestId, { outcome: { outcome: 'selected', optionId: firstOptionId } });
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
