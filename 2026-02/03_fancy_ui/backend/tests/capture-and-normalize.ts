// capture-and-normalize.ts — Unit test for tool call normalization + diff extraction.
//
// Uses hardcoded JSON fixtures based on real captured ACP output (from diffs.md).
// Tests that ToolCallNormalizer + extractDiffs produce identical normalized shape
// regardless of which agent (Claude, Codex, Gemini) produced the messages.
//
// Run: node --experimental-strip-types backend/tests/capture-and-normalize.ts

import assert from 'node:assert/strict';
import { ToolCallNormalizer, type NormalizedToolCall } from '../tool-call-normalizer.ts';
import { extractDiffs, extractAllDiffs, type DiffEvent } from '../diff-stream.ts';

// ─── Fixtures: Real ACP messages as they arrive on stdout ────────────────────
// Wrapped in session/update notifications (the outer envelope from the protocol).

function sessionUpdate(update: Record<string, unknown>) {
  return { jsonrpc: '2.0', method: 'session/update', params: { update } };
}

// ── Claude: empty tool_call, then tool_call_update with content ──

const CLAUDE_TOOL_CALL = sessionUpdate({
  _meta: { claudeCode: { toolName: 'Edit' } },
  toolCallId: 'toolu_01VGr7G2teipoY6KDtrMSu19',
  sessionUpdate: 'tool_call',
  rawInput: {},
  status: 'pending',
  title: 'Edit',
  kind: 'edit',
  content: [],
  locations: [],
});

const CLAUDE_TOOL_CALL_UPDATE = sessionUpdate({
  _meta: { claudeCode: { toolName: 'Edit' } },
  toolCallId: 'toolu_01VGr7G2teipoY6KDtrMSu19',
  sessionUpdate: 'tool_call_update',
  rawInput: {
    replace_all: false,
    file_path: '/tmp/acp-test-claude/app.ts',
    old_string: 'function divide(a: number, b: number): number {\n  return a / b;\n}',
    new_string: 'function divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error("Cannot divide by zero");\n  }\n  return a / b;\n}\n\nfunction modulo(a: number, b: number): number {\n  return a % b;\n}',
  },
  title: 'Edit /tmp/acp-test-claude/app.ts',
  kind: 'edit',
  content: [
    {
      type: 'diff',
      path: '/tmp/acp-test-claude/app.ts',
      oldText: 'function divide(a: number, b: number): number {\n  return a / b;\n}',
      newText: 'function divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error("Cannot divide by zero");\n  }\n  return a / b;\n}\n\nfunction modulo(a: number, b: number): number {\n  return a % b;\n}',
    },
  ],
  locations: [{ path: '/tmp/acp-test-claude/app.ts' }],
});

// ── Codex: full content in tool_call immediately ──

const CODEX_TOOL_CALL = sessionUpdate({
  sessionUpdate: 'tool_call',
  toolCallId: 'call_Tw9hwDVSJgKOJ86277lS88v9',
  title: 'Edit /tmp/acp-diff-workspace/test-edit.txt',
  kind: 'edit',
  status: 'in_progress',
  content: [
    {
      type: 'diff',
      path: '/tmp/acp-diff-workspace/test-edit.txt',
      oldText: 'Line 1: Hello World\nLine 2: ...\nLine 9: TODO: fix this bug\n...\nLine 15: Final line\n',
      newText: 'Line 1: Hello World\nLine 2: ...\nLine 9: DONE: bug is fixed\n...\nLine 15: Final line\n',
    },
  ],
  locations: [{ path: '/tmp/acp-diff-workspace/test-edit.txt' }],
  rawInput: {
    call_id: 'call_Tw9hwDVSJgKOJ86277lS88v9',
    auto_approved: false,
    changes: {
      '/tmp/acp-diff-workspace/test-edit.txt': {
        type: 'update',
        unified_diff: '@@ -8,3 +8,3 @@\n Line 8: }\n-Line 9: TODO: fix this bug\n+Line 9: DONE: bug is fixed\n Line 10: const x = 42;\n',
      },
    },
  },
});

// Codex status-only update (no new content)
const CODEX_TOOL_CALL_UPDATE = sessionUpdate({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_Tw9hwDVSJgKOJ86277lS88v9',
  status: 'completed',
});

// ── Gemini: permission request (not a session/update), then tool_call_update ──

// The permission request — this is NOT a session/update, it's session/request_permission.
// extractDiffs intentionally skips this to avoid duplicates.
const GEMINI_PERMISSION_REQUEST = {
  jsonrpc: '2.0',
  id: 42,
  method: 'session/request_permission',
  params: {
    sessionId: 'c16792d1-fake',
    options: [
      { optionId: 'proceed_always', name: 'Allow All Edits', kind: 'allow_always' },
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
    ],
    toolCall: {
      toolCallId: 'replace-1772804148587',
      status: 'pending',
      title: 'app.ts: function divide(a: number, b: ... => function divide(a: number, b: ...',
      content: [
        {
          type: 'diff',
          path: 'app.ts',
          oldText: 'function divide(a: number, b: number): number {\n  return a / b;\n}\n',
          newText: 'function divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error("Cannot divide by zero");\n  }\n  return a / b;\n}\n\nfunction modulo(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error("Cannot modulo by zero");\n  }\n  return a % b;\n}\n',
          _meta: { kind: 'modify' },
        },
      ],
      locations: [{ path: '/tmp/acp-test-gemini/app.ts' }],
      kind: 'edit',
    },
  },
};

// Gemini initial tool_call (empty content, comes separately)
const GEMINI_TOOL_CALL = sessionUpdate({
  sessionUpdate: 'tool_call',
  toolCallId: 'replace-1772804148587',
  status: 'pending',
  title: 'app.ts: function divide(a: number, b: ... => function divide(a: number, b: ...',
  kind: 'edit',
  content: [],
  locations: [{ path: '/tmp/acp-test-gemini/app.ts' }],
});

// Gemini tool_call_update after permission granted
const GEMINI_TOOL_CALL_UPDATE = sessionUpdate({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'replace-1772804148587',
  status: 'completed',
  content: [
    {
      type: 'diff',
      path: 'app.ts',
      oldText: 'function divide(a: number, b: number): number {\n  return a / b;\n}\n',
      newText: 'function divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error("Cannot divide by zero");\n  }\n  return a / b;\n}\n\nfunction modulo(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error("Cannot modulo by zero");\n  }\n  return a % b;\n}\n',
      _meta: { kind: 'modify' },
    },
  ],
});

// ─── Tests ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ── Claude Tests ──

console.log('\n═══ CLAUDE ═══');

test('tool_call has empty content, tool_call_update has content', () => {
  const normalizer = new ToolCallNormalizer();

  const r1 = normalizer.process(CLAUDE_TOOL_CALL)!;
  assert.ok(r1);
  assert.equal(r1.sessionUpdate, 'tool_call');
  assert.equal(r1.content!.length, 0, 'initial tool_call should have empty content');

  const r2 = normalizer.process(CLAUDE_TOOL_CALL_UPDATE)!;
  assert.ok(r2);
  assert.equal(r2.sessionUpdate, 'tool_call_update');
  assert.equal(r2.content!.length, 1, 'merged update should have 1 content block');
  assert.equal(r2.title, 'Edit /tmp/acp-test-claude/app.ts');
  assert.equal(r2.kind, 'edit');
  assert.equal(r2.toolCallId, 'toolu_01VGr7G2teipoY6KDtrMSu19');
});

test('extractDiffs produces correct DiffEvent from tool_call_update', () => {
  const diffs = extractDiffs(CLAUDE_TOOL_CALL_UPDATE, 1000);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, '/tmp/acp-test-claude/app.ts');
  assert.ok(diffs[0].oldText.includes('return a / b'));
  assert.ok(diffs[0].newText.includes('modulo'));
  assert.equal(diffs[0].toolCallId, 'toolu_01VGr7G2teipoY6KDtrMSu19');
});

test('extractDiffs returns nothing from empty initial tool_call', () => {
  const diffs = extractDiffs(CLAUDE_TOOL_CALL, 1000);
  assert.equal(diffs.length, 0);
});

test('extractAllDiffs deduplicates Claude messages', () => {
  const entries = [
    { payload: CLAUDE_TOOL_CALL, direction: 'out', timestamp: 1000 },
    { payload: CLAUDE_TOOL_CALL_UPDATE, direction: 'out', timestamp: 2000 },
  ];
  const diffs = extractAllDiffs(entries);
  assert.equal(diffs.length, 1, 'should deduplicate to 1 diff');
  assert.equal(diffs[0].timestamp, 2000, 'should keep the later one');
});

// ── Codex Tests ──

console.log('\n═══ CODEX ═══');

test('tool_call has full content immediately', () => {
  const normalizer = new ToolCallNormalizer();

  const r1 = normalizer.process(CODEX_TOOL_CALL)!;
  assert.ok(r1);
  assert.equal(r1.sessionUpdate, 'tool_call');
  assert.equal(r1.content!.length, 1, 'Codex tool_call should have content immediately');
  assert.equal(r1.kind, 'edit');
});

test('status-only update preserves content from initial tool_call', () => {
  const normalizer = new ToolCallNormalizer();

  normalizer.process(CODEX_TOOL_CALL);
  const r2 = normalizer.process(CODEX_TOOL_CALL_UPDATE)!;
  assert.ok(r2);
  assert.equal(r2.sessionUpdate, 'tool_call_update');
  assert.equal(r2.status, 'completed');
  assert.equal(r2.content!.length, 1, 'merged update should still have content from tool_call');
});

test('extractDiffs works from Codex tool_call', () => {
  const diffs = extractDiffs(CODEX_TOOL_CALL, 1000);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, '/tmp/acp-diff-workspace/test-edit.txt');
  assert.ok(diffs[0].oldText.includes('TODO: fix this bug'));
  assert.ok(diffs[0].newText.includes('DONE: bug is fixed'));
});

// ── Gemini Tests ──

console.log('\n═══ GEMINI ═══');

test('permission request is skipped by extractDiffs (no duplicates)', () => {
  const diffs = extractDiffs(GEMINI_PERMISSION_REQUEST, 1000);
  assert.equal(diffs.length, 0, 'should not extract from permission request');
});

test('empty tool_call then tool_call_update merges correctly', () => {
  const normalizer = new ToolCallNormalizer();

  const r1 = normalizer.process(GEMINI_TOOL_CALL)!;
  assert.ok(r1);
  assert.equal(r1.content!.length, 0, 'initial tool_call should be empty');

  const r2 = normalizer.process(GEMINI_TOOL_CALL_UPDATE)!;
  assert.ok(r2);
  assert.equal(r2.sessionUpdate, 'tool_call_update');
  assert.equal(r2.content!.length, 1, 'merged update should have content');
  assert.equal(r2.status, 'completed');
  assert.equal(r2.kind, 'edit');
  assert.equal(r2.toolCallId, 'replace-1772804148587');
});

test('extractDiffs resolves Gemini relative path via locations', () => {
  // Gemini sends relative path "app.ts" in diff but absolute in locations
  // However the tool_call_update fixture doesn't have locations (they were in the initial tool_call).
  // This tests that relative paths are handled.
  const diffs = extractDiffs(GEMINI_TOOL_CALL_UPDATE, 1000);
  assert.equal(diffs.length, 1);
  // Path is "app.ts" (relative) since this update msg has no locations
  assert.equal(diffs[0].path, 'app.ts');
  assert.ok(diffs[0].newText.includes('modulo'));
});

test('normalizer + extractDiffs together resolves Gemini path', () => {
  // When using normalizer, the merged object should have locations from the initial tool_call
  const normalizer = new ToolCallNormalizer();
  normalizer.process(GEMINI_TOOL_CALL);
  const merged = normalizer.process(GEMINI_TOOL_CALL_UPDATE)!;

  // The merged object has locations from the initial tool_call
  assert.ok(merged.locations);
  assert.equal(merged.locations!.length, 1);
  assert.equal(merged.locations![0].path, '/tmp/acp-test-gemini/app.ts');

  // Now if we reconstruct a session/update from the merged object and extract diffs,
  // the path should be resolved to absolute
  const reconstructed = sessionUpdate(merged as any);
  const diffs = extractDiffs(reconstructed, 1000);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, '/tmp/acp-test-gemini/app.ts', 'path should be resolved to absolute via locations');
});

// ── Cross-agent alignment ──

console.log('\n═══ CROSS-AGENT ALIGNMENT ═══');

test('all agents produce normalized tool calls with same shape', () => {
  const claudeNorm = new ToolCallNormalizer();
  claudeNorm.process(CLAUDE_TOOL_CALL);
  const claude = claudeNorm.process(CLAUDE_TOOL_CALL_UPDATE)!;

  const codexNorm = new ToolCallNormalizer();
  codexNorm.process(CODEX_TOOL_CALL);
  const codex = codexNorm.process(CODEX_TOOL_CALL_UPDATE)!;

  const geminiNorm = new ToolCallNormalizer();
  geminiNorm.process(GEMINI_TOOL_CALL);
  const gemini = geminiNorm.process(GEMINI_TOOL_CALL_UPDATE)!;

  // All three should have: toolCallId, kind, content with at least one diff block, status
  for (const [name, tc] of [['claude', claude], ['codex', codex], ['gemini', gemini]] as const) {
    assert.ok(tc.toolCallId, `${name}: missing toolCallId`);
    assert.equal(tc.kind, 'edit', `${name}: kind should be 'edit'`);
    assert.ok(tc.content && tc.content.length > 0, `${name}: should have content`);
    assert.ok(tc.status, `${name}: missing status`);

    const diffBlock = tc.content![0] as any;
    assert.equal(diffBlock.type, 'diff', `${name}: content[0].type should be 'diff'`);
    assert.ok(typeof diffBlock.path === 'string', `${name}: diff should have path`);
    assert.ok(typeof diffBlock.oldText === 'string', `${name}: diff should have oldText`);
    assert.ok(typeof diffBlock.newText === 'string', `${name}: diff should have newText`);
    assert.notEqual(diffBlock.oldText, diffBlock.newText, `${name}: oldText should differ from newText`);
  }
});

test('all agents produce DiffEvents with same shape', () => {
  const claudeDiffs = extractDiffs(CLAUDE_TOOL_CALL_UPDATE, 1000);
  const codexDiffs = extractDiffs(CODEX_TOOL_CALL, 1000);

  // For Gemini, use the normalizer+extractDiffs combo to get absolute paths
  const geminiNorm = new ToolCallNormalizer();
  geminiNorm.process(GEMINI_TOOL_CALL);
  const geminiMerged = geminiNorm.process(GEMINI_TOOL_CALL_UPDATE)!;
  const geminiDiffs = extractDiffs(sessionUpdate(geminiMerged as any), 1000);

  for (const [name, diffs] of [['claude', claudeDiffs], ['codex', codexDiffs], ['gemini', geminiDiffs]] as const) {
    assert.ok(diffs.length > 0, `${name}: should have at least one diff`);
    const d = diffs[0];
    assert.ok(d.id, `${name}: missing id`);
    assert.ok(d.toolCallId, `${name}: missing toolCallId`);
    assert.ok(d.path.startsWith('/'), `${name}: path should be absolute, got: ${d.path}`);
    assert.ok(d.oldText.length > 0, `${name}: oldText should not be empty`);
    assert.ok(d.newText.length > 0, `${name}: newText should not be empty`);
    assert.notEqual(d.oldText, d.newText, `${name}: should have actual changes`);
    assert.equal(d.timestamp, 1000, `${name}: timestamp should be preserved`);
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
