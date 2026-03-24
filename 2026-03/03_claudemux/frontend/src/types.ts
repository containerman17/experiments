// ClaudeMux shared types — WebSocket protocol
// Server is a pure tmux-to-websocket bridge + voice transcription relay.

export interface SessionInfo {
  name: string;       // tmux session name
  created: number;    // unix timestamp
  width: number;
  height: number;
  attached: boolean;  // whether tmux shows it as attached
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
  | { type: 'voice.transcribe'; session: string; audio: string; mimeType: string };

// --- Server → Client ---

export type ServerMessage =
  | { type: 'sessions.list'; sessions: SessionInfo[] }
  | { type: 'terminal.output'; session: string; data: string }  // base64
  | { type: 'terminal.exited'; session: string }
  | { type: 'voice.result'; session: string; text: string }
  | { type: 'voice.error'; message: string }
  | { type: 'error'; message: string };
