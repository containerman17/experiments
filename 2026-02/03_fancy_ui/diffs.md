# ACP Diff Formats by Agent

## Common Format

All agents use the ACP standard `type: "diff"` content block with `oldText`/`newText`:

```json
{
  "type": "diff",
  "path": "/absolute/path/to/file",
  "oldText": "original content",
  "newText": "modified content"
}
```

---

## Claude (claude-agent-acp)

- Diff arrives in `tool_call_update` (NOT the initial `tool_call` which has `content: []`)
- Initial `tool_call` has empty content and locations
- The update merges in `rawInput`, `title`, `content`, `locations`
- Edit failed due to "don't ask mode" — needs permission grant or allowedTools config

### Initial tool_call
```json
{
  "_meta": { "claudeCode": { "toolName": "Edit" } },
  "toolCallId": "toolu_01VGr7G2teipoY6KDtrMSu19",
  "sessionUpdate": "tool_call",
  "rawInput": {},
  "status": "pending",
  "title": "Edit",
  "kind": "edit",
  "content": [],
  "locations": []
}
```

### tool_call_update (has the diff!)
```json
{
  "_meta": { "claudeCode": { "toolName": "Edit" } },
  "toolCallId": "toolu_01VGr7G2teipoY6KDtrMSu19",
  "sessionUpdate": "tool_call_update",
  "rawInput": {
    "replace_all": false,
    "file_path": "/tmp/acp-test-claude/app.ts",
    "old_string": "function divide(a: number, b: number): number {\n  return a / b;\n}",
    "new_string": "function divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error(\"Cannot divide by zero\");\n  }\n  return a / b;\n}\n\nfunction modulo(a: number, b: number): number {\n  return a % b;\n}"
  },
  "title": "Edit /tmp/acp-test-claude/app.ts",
  "kind": "edit",
  "content": [
    {
      "type": "diff",
      "path": "/tmp/acp-test-claude/app.ts",
      "oldText": "function divide(a: number, b: number): number {\n  return a / b;\n}",
      "newText": "function divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error(\"Cannot divide by zero\");\n  }\n  return a / b;\n}\n\nfunction modulo(a: number, b: number): number {\n  return a % b;\n}"
    }
  ],
  "locations": [
    { "path": "/tmp/acp-test-claude/app.ts" }
  ]
}
```

---

## Codex (codex-acp)

- Diff arrives in the initial `tool_call` (content is populated immediately)
- Also includes `rawInput.changes` with a `unified_diff` field

### tool_call
```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call_Tw9hwDVSJgKOJ86277lS88v9",
  "title": "Edit /tmp/acp-diff-workspace/test-edit.txt",
  "kind": "edit",
  "status": "in_progress",
  "content": [
    {
      "type": "diff",
      "path": "/tmp/acp-diff-workspace/test-edit.txt",
      "oldText": "Line 1: Hello World\nLine 2: ...\nLine 9: TODO: fix this bug\n...\nLine 15: Final line\n",
      "newText": "Line 1: Hello World\nLine 2: ...\nLine 9: DONE: bug is fixed\n...\nLine 15: Final line\n"
    }
  ],
  "locations": [
    { "path": "/tmp/acp-diff-workspace/test-edit.txt" }
  ],
  "rawInput": {
    "call_id": "call_Tw9hwDVSJgKOJ86277lS88v9",
    "auto_approved": false,
    "changes": {
      "/tmp/acp-diff-workspace/test-edit.txt": {
        "type": "update",
        "unified_diff": "@@ -8,3 +8,3 @@\n Line 8: }\n-Line 9: TODO: fix this bug\n+Line 9: DONE: bug is fixed\n Line 10: const x = 42;\n",
        "old_content": "...(full file)...",
        "new_content": "...(full file)..."
      }
    }
  }
}
```

---

## Gemini (gemini --experimental-acp)

- Diff arrives in TWO places: the `session/request_permission` params AND `tool_call_update`
- Gemini sends permission request BEFORE editing — diff is in `params.toolCall.content`
- After permission granted, sends `tool_call_update` with same diff content
- Uses **relative path** in diff (`app.ts`) but absolute in locations
- Has `_meta.kind: "modify"` on diff blocks
- Supports modes: `default` (prompts), `autoEdit` (auto-approve edits), `yolo` (auto-approve all)
- Edit succeeded and file was actually modified

### Permission request (has the diff before edit happens)
```json
{
  "sessionId": "c16792d1-...",
  "options": [
    { "optionId": "proceed_always", "name": "Allow All Edits", "kind": "allow_always" },
    { "optionId": "proceed_once", "name": "Allow", "kind": "allow_once" },
    { "optionId": "cancel", "name": "Reject", "kind": "reject_once" }
  ],
  "toolCall": {
    "toolCallId": "replace-1772804148587",
    "status": "pending",
    "title": "app.ts: function divide(a: number, b: ... => function divide(a: number, b: ...",
    "content": [
      {
        "type": "diff",
        "path": "app.ts",
        "oldText": "// Simple calculator app\n...(full file)...\nfunction divide(a: number, b: number): number {\n  return a / b;\n}\n",
        "newText": "// Simple calculator app\n...(full file)...\nfunction divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error(\"Cannot divide by zero\");\n  }\n  return a / b;\n}\n\nfunction modulo(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error(\"Cannot modulo by zero\");\n  }\n  return a % b;\n}\n",
        "_meta": { "kind": "modify" }
      }
    ],
    "locations": [
      { "path": "/tmp/acp-test-gemini/app.ts" }
    ],
    "kind": "edit"
  }
}
```

### tool_call_update (after permission granted, edit complete)
```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "replace-1772804148587",
  "status": "completed",
  "content": [
    {
      "type": "diff",
      "path": "app.ts",
      "oldText": "...(full old file)...",
      "newText": "...(full new file with divide error handling + modulo)...",
      "_meta": { "kind": "modify" }
    }
  ]
}
```

---

## Key Differences Summary

| Aspect | Claude | Codex | Gemini |
|--------|--------|-------|--------|
| Diff in initial `tool_call` | No (`content: []`) | Yes | No (separate `tool_call` msg) |
| Diff in `tool_call_update` | Yes | No | Yes |
| Diff in permission request | N/A | N/A | Yes (`params.toolCall.content`) |
| Path format | Absolute | Absolute | Relative in diff, absolute in locations |
| oldText scope | Changed lines only | Full file | Full file |
| Extra fields | `rawInput.old_string/new_string` | `rawInput.changes[].unified_diff` | `_meta.kind` |
