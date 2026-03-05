import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentInfo, WorkspaceInfo, AgentLogEntry } from '../shared/types.ts';

const DATA_DIR = join(homedir(), '.agent-ui');
const DB_PATH = join(DATA_DIR, 'data.db');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    direction TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_log_agent_ts ON agent_log(agent_id, timestamp);

  CREATE TABLE IF NOT EXISTS config_preferences (
    agent_type TEXT NOT NULL,
    config_id TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (agent_type, config_id)
  );

  CREATE TABLE IF NOT EXISTS tab_state (
    folder TEXT PRIMARY KEY,
    tabs TEXT NOT NULL,
    active_tab_id TEXT
  );

  CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// --- Prepared statements ---

const stmtInsertAgent = db.prepare(
  `INSERT INTO agents (id, folder, agent_type, created_at) VALUES (?, ?, ?, ?)`
);

const stmtArchiveAgent = db.prepare(
  `UPDATE agents SET archived = 1 WHERE id = ?`
);

const stmtListAgents = db.prepare(
  `SELECT id, folder, agent_type AS agentType, created_at AS createdAt
   FROM agents WHERE folder = ? AND archived = 0 ORDER BY created_at DESC`
);

const stmtGetAgent = db.prepare(
  `SELECT id, folder, agent_type AS agentType, created_at AS createdAt
   FROM agents WHERE id = ? AND archived = 0`
);

const stmtListWorkspaces = db.prepare(
  `SELECT folder, COUNT(*) AS agentCount
   FROM agents WHERE archived = 0 GROUP BY folder ORDER BY MAX(created_at) DESC`
);

const stmtInsertLog = db.prepare(
  `INSERT INTO agent_log (agent_id, direction, payload, timestamp) VALUES (?, ?, ?, ?)`
);

const stmtGetLogRecent = db.prepare(
  `SELECT id, agent_id AS agentId, direction, payload, timestamp
   FROM agent_log WHERE agent_id = ? ORDER BY id DESC LIMIT ?`
);

const stmtGetLogBefore = db.prepare(
  `SELECT id, agent_id AS agentId, direction, payload, timestamp
   FROM agent_log WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
);

const stmtUpsertPref = db.prepare(
  `INSERT INTO config_preferences (agent_type, config_id, value) VALUES (?, ?, ?)
   ON CONFLICT(agent_type, config_id) DO UPDATE SET value = excluded.value`
);

const stmtGetPrefs = db.prepare(
  `SELECT config_id, value FROM config_preferences WHERE agent_type = ?`
);

// --- API ---

export function createAgent(id: string, folder: string, agentType: string): AgentInfo {
  const now = Date.now();
  stmtInsertAgent.run(id, folder, agentType, now);
  return { id, folder, agentType: agentType as AgentInfo['agentType'], createdAt: now };
}

export function archiveAgent(id: string): void {
  stmtArchiveAgent.run(id);
}

export function getAgent(id: string): AgentInfo | undefined {
  return stmtGetAgent.get(id) as AgentInfo | undefined;
}

export function listAgents(folder: string): AgentInfo[] {
  return stmtListAgents.all(folder) as AgentInfo[];
}

export function listWorkspaces(): WorkspaceInfo[] {
  return stmtListWorkspaces.all() as WorkspaceInfo[];
}

export function appendLog(agentId: string, direction: 'in' | 'out', payload: unknown): void {
  stmtInsertLog.run(agentId, direction, JSON.stringify(payload), Date.now());
}

export function getHistory(agentId: string, limit: number, before?: number): { entries: AgentLogEntry[]; hasMore: boolean } {
  const fetchLimit = limit + 1;
  const rows = before
    ? stmtGetLogBefore.all(agentId, before, fetchLimit) as Array<{ id: number; agentId: string; direction: string; payload: string; timestamp: number }>
    : stmtGetLogRecent.all(agentId, fetchLimit) as Array<{ id: number; agentId: string; direction: string; payload: string; timestamp: number }>;

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;

  // Reverse to chronological order (oldest first)
  const entries: AgentLogEntry[] = trimmed.reverse().map(r => ({
    id: r.id,
    agentId: r.agentId,
    direction: r.direction as 'in' | 'out',
    payload: JSON.parse(r.payload),
    timestamp: r.timestamp,
  }));

  return { entries, hasMore };
}

export function setConfigPreference(agentType: string, configId: string, value: string): void {
  stmtUpsertPref.run(agentType, configId, value);
}

export function getConfigPreferences(agentType: string): Record<string, string> {
  const rows = stmtGetPrefs.all(agentType) as Array<{ config_id: string; value: string }>;
  const prefs: Record<string, string> = {};
  for (const r of rows) prefs[r.config_id] = r.value;
  return prefs;
}

// --- Terminal tracking ---

const stmtInsertTerminal = db.prepare(
  `INSERT INTO terminals (id, folder, created_at) VALUES (?, ?, ?)`
);

const stmtDeleteTerminal = db.prepare(
  `DELETE FROM terminals WHERE id = ?`
);

const stmtListAllTerminals = db.prepare(
  `SELECT id, folder, created_at AS createdAt FROM terminals`
);

export function trackTerminal(id: string, folder: string): void {
  stmtInsertTerminal.run(id, folder, Date.now());
}

export function untrackTerminal(id: string): void {
  stmtDeleteTerminal.run(id);
}

export function listAllTrackedTerminals(): Array<{ id: string; folder: string; createdAt: number }> {
  return stmtListAllTerminals.all() as Array<{ id: string; folder: string; createdAt: number }>;
}

// --- Tab state persistence ---

const stmtUpsertTabState = db.prepare(
  `INSERT INTO tab_state (folder, tabs, active_tab_id) VALUES (?, ?, ?)
   ON CONFLICT(folder) DO UPDATE SET tabs = excluded.tabs, active_tab_id = excluded.active_tab_id`
);

const stmtGetTabState = db.prepare(
  `SELECT tabs, active_tab_id FROM tab_state WHERE folder = ?`
);

export function saveTabState(folder: string, tabs: unknown[], activeTabId: string | null): void {
  stmtUpsertTabState.run(folder, JSON.stringify(tabs), activeTabId);
}

export function loadTabState(folder: string): { tabs: unknown[]; activeTabId: string | null } | null {
  const row = stmtGetTabState.get(folder) as { tabs: string; active_tab_id: string | null } | undefined;
  if (!row) return null;
  return { tabs: JSON.parse(row.tabs), activeTabId: row.active_tab_id };
}

export default db;
