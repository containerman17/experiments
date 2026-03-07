// tool-call-normalizer.ts — Merges tool_call + tool_call_update into complete objects.
//
// ACP agents split tool call data across multiple messages differently:
//   - Claude: empty content in tool_call, full data in tool_call_update
//   - Codex: full data in tool_call, only status in tool_call_update
//   - Gemini: empty in tool_call, data arrives after permission grant in tool_call_update
//
// This normalizer accumulates by toolCallId so the frontend always receives
// a complete, merged tool call object on every update.
//
// See tool-call-normalization.md for the full spec.

export interface NormalizedToolCall {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  status?: string;
  title?: string;
  kind?: string;
  content?: unknown[];
  locations?: Array<{ path: string }>;
  rawInput?: unknown;
  _meta?: unknown;
}

export class ToolCallNormalizer {
  private store = new Map<string, NormalizedToolCall>();

  // Process an incoming session/update payload.
  // Returns the normalized (merged) tool call to forward, or null if not a tool call message.
  process(payload: unknown): NormalizedToolCall | null {
    if (!payload || typeof payload !== 'object') return null;
    const msg = payload as Record<string, unknown>;

    if (msg.method !== 'session/update') return null;

    const update = (msg.params as Record<string, unknown>)?.update as Record<string, unknown> | undefined;
    if (!update) return null;

    const sessionUpdate = update.sessionUpdate as string | undefined;
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return null;

    const toolCallId = update.toolCallId as string;
    if (!toolCallId) return null;

    if (sessionUpdate === 'tool_call') {
      // Store the initial tool call
      const entry: NormalizedToolCall = {
        sessionUpdate: 'tool_call',
        toolCallId,
        status: update.status as string | undefined,
        title: update.title as string | undefined,
        kind: update.kind as string | undefined,
        content: update.content as unknown[] | undefined,
        locations: update.locations as Array<{ path: string }> | undefined,
        rawInput: update.rawInput as unknown,
        _meta: update._meta as unknown,
      };
      this.store.set(toolCallId, entry);
      return { ...entry };
    }

    // tool_call_update — merge into stored
    const stored = this.store.get(toolCallId);
    if (!stored) {
      // No prior tool_call seen — treat as standalone (shouldn't happen but be safe)
      const entry: NormalizedToolCall = {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: update.status as string | undefined,
        title: update.title as string | undefined,
        kind: update.kind as string | undefined,
        content: update.content as unknown[] | undefined,
        locations: update.locations as Array<{ path: string }> | undefined,
        rawInput: update.rawInput as unknown,
        _meta: update._meta as unknown,
      };
      this.store.set(toolCallId, entry);
      return { ...entry };
    }

    // Merge non-empty fields
    const arr = update.content as unknown[] | undefined;
    if (arr && arr.length > 0) stored.content = arr;
    if (update.title) stored.title = update.title as string;
    if (update.status) stored.status = update.status as string;
    const locs = update.locations as Array<{ path: string }> | undefined;
    if (locs && locs.length > 0) stored.locations = locs;
    if (update.kind) stored.kind = update.kind as string;
    if (update.rawInput) stored.rawInput = update.rawInput;
    if (update._meta) stored._meta = update._meta;

    // Clean up on terminal status
    const status = stored.status;
    if (status === 'completed' || status === 'failed') {
      this.store.delete(toolCallId);
    }

    return { ...stored, sessionUpdate: 'tool_call_update' };
  }

  // Reset state (useful between tests)
  clear(): void {
    this.store.clear();
  }
}
