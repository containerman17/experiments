# Tool Call Normalization

## Problem

ACP agents send tool call data across multiple messages:

1. **`tool_call`** — initial announcement (may or may not have content)
2. **`tool_call_update`** — one or more updates with status changes, content, locations, title

Each agent splits data differently:

| Agent | Initial `tool_call` has content? | `tool_call_update` has content? |
|-------|----------------------------------|--------------------------------|
| Claude | No (`content: []`) | Yes (diff, rawInput, title, locations arrive in update) |
| Codex | Yes (full diff immediately) | No (only status changes) |
| Gemini | No (`content: []`) | Yes (diff arrives after permission grant) |

Frontends must not care about these differences.

## Solution

The backend normalizes the WebSocket stream. Each tool call is accumulated by `toolCallId` and forwarded as a complete merged object.

### Rules

1. **On `tool_call`**: Store the full object in a `Map<toolCallId, ToolCall>`. Forward as-is.
2. **On `tool_call_update`**: Merge non-empty fields into the stored tool call. Forward the **merged object** (with `sessionUpdate` set to `tool_call_update` so the frontend knows it's an update, not a new call).
3. **On `completed` or `failed` status**: Delete from the Map after forwarding.
4. **SQLite**: Always stores the raw, unmodified ACP message. Normalization only applies to the WebSocket stream.
5. **History replay**: When a frontend loads history (`agent.history`), run the same merge pass over the raw log entries before sending.

### Merge logic

```
function mergeToolCallUpdate(stored, update):
  if update.content?.length > 0:    stored.content = update.content
  if update.title:                   stored.title = update.title
  if update.status:                  stored.status = update.status
  if update.locations?.length > 0:   stored.locations = update.locations
  if update.kind:                    stored.kind = update.kind
  if update.rawInput:                stored.rawInput = update.rawInput
  return stored
```

Fields are replaced, not appended. Each update carries the full current state of that field.

### What frontends receive

Every `tool_call_update` arrives as a complete tool call object:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "toolu_abc123",
  "status": "completed",
  "title": "Edit /path/to/file.ts",
  "kind": "edit",
  "content": [
    {
      "type": "diff",
      "path": "/path/to/file.ts",
      "oldText": "...",
      "newText": "..."
    }
  ],
  "locations": [
    { "path": "/path/to/file.ts" }
  ]
}
```

The frontend can render any `tool_call` or `tool_call_update` directly — no accumulation needed on the client side.

### Diff content format

All three agents use the same ACP diff structure:

```json
{
  "type": "diff",
  "path": "file path (may be relative for Gemini)",
  "oldText": "content before edit",
  "newText": "content after edit"
}
```

The `oldText` scope varies — Claude sends only the changed fragment, Codex and Gemini send the full file. The frontend diff renderer must handle both.

### Memory usage

Map entries exist only for the duration of a tool call (typically seconds). Entries are cleaned up on `completed`/`failed`. A typical agent turn has 1-5 concurrent tool calls, so the Map stays tiny.

---

## Implementation Status

### Done

- **`backend/tool-call-normalizer.ts`** — `ToolCallNormalizer` class. Stateful accumulator with `process(payload)` method. Returns merged `NormalizedToolCall` for tool_call/tool_call_update messages, `null` for everything else. Cleans up Map on `completed`/`failed`.
- **`backend/diff-stream.ts`** — `extractDiffs()` and `extractAllDiffs()` for pulling `DiffEvent[]` from ACP messages. Handles all three agents. Skips permission requests to avoid Gemini duplicates.
- **`backend/tests/capture-and-normalize.ts`** — 13 fixture-based tests using real captured JSON from all three agents. Verifies normalization, deduplication, Gemini relative path resolution, and cross-agent output alignment. Run: `node --experimental-strip-types backend/tests/capture-and-normalize.ts`

### TODO: Integration into agent-manager.ts

1. Create a `ToolCallNormalizer` per `LiveAgent` instance
2. In the stdout handler (`proc.stdout.on('data', ...)`), after parsing each message:
   - Call `normalizer.process(payload)`
   - If it returns a `NormalizedToolCall`, replace `params.update` in the broadcast payload with the merged version
   - SQLite still stores the raw, unmodified payload
3. In `getAgentHistory()`, create a temp normalizer and replay raw log entries through it before sending to the frontend
4. On agent process exit/cleanup, the normalizer is garbage collected with the `LiveAgent`
