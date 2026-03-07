import { useMemo, useEffect, useRef } from 'react';
import type { AgentState } from '../store';
import { type RpcMessage, isNotification } from '../acp';

export function DiffStream({ agent }: { agent: AgentState }) {
  const diffsEndRef = useRef<HTMLDivElement>(null);

  const diffs = useMemo(() => {
    // Dedup by toolCallId — later updates replace earlier ones (normalized merge)
    const byId = new Map<string, { toolCallId: string; title: string; diffs: any[] }>();
    for (const entry of agent.log) {
      if (entry.direction !== 'out') continue;
      const msg = entry.payload as RpcMessage;
      if (isNotification(msg) && msg.method === 'session/update') {
        const u = msg.params?.update;
        if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
          const content = u.content as any[] | undefined;
          const diffContent = content?.filter((c: any) => c.type === 'diff') || [];
          if (diffContent.length > 0) {
            byId.set(u.toolCallId, {
              toolCallId: u.toolCallId,
              title: u.title,
              diffs: diffContent,
            });
          }
        }
      }
    }
    return Array.from(byId.values());
  }, [agent.log]);

  const mountedRef = useRef(false);
  useEffect(() => {
    const behavior = mountedRef.current ? 'smooth' : 'instant';
    mountedRef.current = true;
    diffsEndRef.current?.scrollIntoView({ behavior });
  }, [diffs.length]);

  if (diffs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
        No code changes yet.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-4 flex flex-col gap-6">
      {diffs.map((tc, i) => (
        <div key={`${tc.toolCallId}-${i}`} className="flex flex-col gap-2">
          {tc.diffs.map((diff: any, j: number) => (
            <DiffBlock key={j} diff={diff} />
          ))}
        </div>
      ))}
      <div ref={diffsEndRef} />
    </div>
  );
}

function DiffBlock({ diff }: { diff: any }) {
  // Normalized content has oldText/newText — generate a simple inline diff
  // oldText can be null for new files (Write tool)
  if (diff.newText != null) {
    const oldLines = (diff.oldText || '').split('\n');
    const newLines = diff.newText.split('\n');
    // Simple line-level diff: show removed then added lines
    const lines: { text: string; type: 'add' | 'remove' | 'context' }[] = [];
    // Find common prefix/suffix for context
    let i = 0;
    while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
      lines.push({ text: ' ' + oldLines[i], type: 'context' });
      i++;
    }
    let oe = oldLines.length - 1, ne = newLines.length - 1;
    const suffixLines: { text: string; type: 'context' }[] = [];
    while (oe > i && ne > i && oldLines[oe] === newLines[ne]) {
      suffixLines.unshift({ text: ' ' + oldLines[oe], type: 'context' });
      oe--; ne--;
    }
    for (let j = i; j <= oe; j++) lines.push({ text: '-' + oldLines[j], type: 'remove' });
    for (let j = i; j <= ne; j++) lines.push({ text: '+' + newLines[j], type: 'add' });
    lines.push(...suffixLines);

    // Trim context lines to at most CONTEXT_LINES before/after the changed region
    const CONTEXT_LINES = 3;
    const firstChanged = lines.findIndex(l => l.type !== 'context');
    const lastChanged = lines.length - 1 - [...lines].reverse().findIndex(l => l.type !== 'context');
    if (firstChanged > CONTEXT_LINES || (lines.length - 1 - lastChanged) > CONTEXT_LINES) {
      const start = Math.max(0, firstChanged - CONTEXT_LINES);
      const end = Math.min(lines.length, lastChanged + CONTEXT_LINES + 1);
      const trimmed = lines.slice(start, end);
      if (start > 0) trimmed.unshift({ text: ' ···', type: 'context' });
      if (end < lines.length) trimmed.push({ text: ' ···', type: 'context' });
      lines.length = 0;
      lines.push(...trimmed);
    }

    return (
      <div className="text-[11px] font-mono">
        {diff.path && (
          <div className="px-4 py-2 text-zinc-300 font-semibold border-y border-zinc-800/50 bg-zinc-900/30">
            {diff.path}
          </div>
        )}
        <div className="overflow-x-auto py-2">
          {lines.map((line, i) => {
            let bg = '';
            let color = 'text-zinc-400';
            if (line.type === 'add') { bg = 'bg-green-950/40'; color = 'text-green-400'; }
            else if (line.type === 'remove') { bg = 'bg-red-950/40'; color = 'text-red-400'; }
            return (
              <div key={i} className={`px-4 min-w-max ${bg}`}>
                <span className={`${color} whitespace-pre`}>{line.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const patch = diff.patch || diff.after || '';
  if (!patch) return null;

  const lines = patch.split('\n');

  return (
    <div className="text-[11px] font-mono">
      {diff.path && (
        <div className="px-4 py-2 text-zinc-300 font-semibold border-y border-zinc-800/50 bg-zinc-900/30">
          {diff.path}
        </div>
      )}
      <div className="overflow-x-auto py-2">
        {lines.map((line: string, i: number) => {
          let bg = '';
          let color = 'text-zinc-400';
          if (line.startsWith('+')) { bg = 'bg-green-950/40'; color = 'text-green-400'; }
          else if (line.startsWith('-')) { bg = 'bg-red-950/40'; color = 'text-red-400'; }
          else if (line.startsWith('@@')) { color = 'text-blue-400'; }
          
          return (
            <div key={i} className={`px-4 min-w-max ${bg}`}>
              <span className={`${color} whitespace-pre`}>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
