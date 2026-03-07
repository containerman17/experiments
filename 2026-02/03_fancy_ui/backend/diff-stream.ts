// diff-stream.ts — Extracts diffs from raw ACP log entries into a unified stream format.
//
// The problem: Claude, Codex, and Gemini each emit file-edit diffs in different
// ACP message shapes. This module normalizes all three into a single DiffEvent
// format suitable for streaming to the frontend's "Diff Stream" column.
//
// See diffs.md at project root for the raw format documentation per agent.

export interface DiffEvent {
  // Unique ID for deduplication (toolCallId + path)
  id: string;
  // Which tool call produced this diff
  toolCallId: string;
  // Absolute path to the file that was changed
  path: string;
  // The old and new text (scope varies by agent — could be full file or just the changed region)
  oldText: string;
  newText: string;
  // Human-readable title if available (e.g. "Edit /tmp/foo.ts")
  title?: string;
  // Timestamp from the log entry
  timestamp: number;
}

// ─── Internals ──────────────────────────────────────────────────────────────

// A diff content block as it appears in ACP messages from all three agents.
interface AcpDiffBlock {
  type: 'diff';
  path: string;
  oldText: string;
  newText: string;
  _meta?: { kind?: string };
}

// Checks if a content block is a diff block.
function isDiffBlock(block: unknown): block is AcpDiffBlock {
  if (!block || typeof block !== 'object') return false;
  const b = block as Record<string, unknown>;
  return b.type === 'diff' && typeof b.path === 'string';
}

// Resolves a potentially relative path using the locations array.
// Gemini sends relative paths in diff blocks but absolute paths in locations.
function resolvePath(diffPath: string, locations?: Array<{ path: string }>): string {
  if (diffPath.startsWith('/')) return diffPath;
  // Try to find a matching absolute path in locations
  if (locations) {
    const match = locations.find((loc) => loc.path.endsWith(diffPath));
    if (match) return match.path;
  }
  return diffPath;
}

// ─── Main extraction ────────────────────────────────────────────────────────

// Extracts DiffEvents from a single ACP log entry's payload.
// Returns an empty array if the entry contains no diffs.
//
// Handles these message shapes:
//   1. session/update notification with sessionUpdate: "tool_call" (Codex)
//   2. session/update notification with sessionUpdate: "tool_call_update" (Claude, Gemini)
//   3. session/request_permission request with toolCall containing diffs (Gemini)
//
// We intentionally skip permission-request diffs to avoid duplicates:
// Gemini sends the diff in both the permission request AND the subsequent tool_call_update.
// We only extract from tool_call / tool_call_update.
export function extractDiffs(payload: unknown, timestamp: number): DiffEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const msg = payload as Record<string, unknown>;

  // ── Case 1 & 2: session/update notifications ──
  // These carry tool_call or tool_call_update in params.update
  if (msg.method === 'session/update') {
    const update = (msg.params as Record<string, unknown>)?.update as Record<string, unknown> | undefined;
    if (!update) return [];

    const sessionUpdate = update.sessionUpdate as string | undefined;
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return [];

    const content = update.content as unknown[] | undefined;
    if (!content || !Array.isArray(content)) return [];

    const toolCallId = (update.toolCallId as string) || 'unknown';
    const title = update.title as string | undefined;
    const locations = update.locations as Array<{ path: string }> | undefined;

    return content.filter(isDiffBlock).map((block) => ({
      id: `${toolCallId}:${block.path}`,
      toolCallId,
      path: resolvePath(block.path, locations),
      oldText: block.oldText,
      newText: block.newText,
      title,
      timestamp,
    }));
  }

  return [];
}

// Batch version: processes an array of log entries and returns all diffs in order.
// Deduplicates by id — if a tool_call and tool_call_update both contain the same
// diff (same toolCallId + path), only the latest one is kept.
export function extractAllDiffs(
  entries: Array<{ payload: unknown; direction: string; timestamp: number }>,
): DiffEvent[] {
  const seen = new Map<string, DiffEvent>();

  for (const entry of entries) {
    // Only process outbound messages (agent → client)
    if (entry.direction !== 'out') continue;

    const diffs = extractDiffs(entry.payload, entry.timestamp);
    for (const diff of diffs) {
      // Later entries overwrite earlier ones with the same id (dedup)
      seen.set(diff.id, diff);
    }
  }

  return Array.from(seen.values());
}
