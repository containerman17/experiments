// ClaudeMux shared types — WebSocket protocol
// Server is a pure tmux-to-websocket bridge + voice transcription relay + tunnel manager.

export interface SessionInfo {
  name: string;       // tmux session name
  path: string;       // working directory for the session
  created: number;    // unix timestamp
  width: number;
  height: number;
  attached: boolean;  // whether tmux shows it as attached
}

export interface TunnelInfo {
  port: number;
  url: string | null;  // null while starting
  status: 'starting' | 'running' | 'error';
  error?: string;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface FilePreview {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  lineCount: number;
  byteCount: number;
}

// --- Client → Server ---

export type ClientMessage =
  | { type: 'sessions.list' }
  | { type: 'terminal.attach'; session: string }
  | { type: 'terminal.detach'; session: string }
  | { type: 'terminal.input'; session: string; data: string }
  | { type: 'terminal.resize'; session: string; cols: number; rows: number }
  | { type: 'terminal.sendkeys'; session: string; keys: string }
  | { type: 'terminal.scroll'; session: string; lines: number }
  | { type: 'voice.transcribe'; session: string; audio: string; mimeType: string }
  | { type: 'tunnels.list' }
  | { type: 'tunnels.create'; port: number }
  | { type: 'tunnels.delete'; port: number }
  | { type: 'files.list'; path: string }
  | { type: 'files.preview'; path: string }
  | { type: 'files.mkdir'; path: string }
  | { type: 'files.createSession'; path: string }
  | { type: 'files.upload'; session: string; name: string; data: string }; // data is base64

// --- Server → Client ---

export type ServerMessage =
  | { type: 'sessions.list'; sessions: SessionInfo[] }
  | { type: 'files.sessionCreated'; session: string; path: string }
  | { type: 'terminal.output'; session: string; data: string }  // base64
  | { type: 'terminal.exited'; session: string }
  | { type: 'voice.result'; session: string; text: string }
  | { type: 'voice.error'; message: string }
  | { type: 'tunnels.list'; tunnels: TunnelInfo[] }
  | { type: 'files.list'; path: string; entries: FileEntry[] }
  | ({ type: 'files.preview' } & FilePreview)
  | { type: 'files.sessionDirs'; dirs: string[] }
  | { type: 'files.uploaded'; session: string; path: string }
  | { type: 'files.error'; message: string }
  | { type: 'error'; message: string };
