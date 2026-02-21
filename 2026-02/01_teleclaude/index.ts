import { Bot } from "grammy";
import yaml from "js-yaml";

interface BotConfig {
  token: string;
  cwd: string;
  session_id?: string;
}

interface Config {
  gemini_api_key: string;
  gemini_model: string;
  bots: Record<string, BotConfig>;
}

const configIdx = process.argv.indexOf("--config");
const CONFIG_PATH: string = configIdx !== -1 && process.argv[configIdx + 1] ? process.argv[configIdx + 1]! : "config.yaml";
const cfg = yaml.load(await Bun.file(CONFIG_PATH).text()) as Config;
cfg.gemini_model = cfg.gemini_model || "gemini-3-pro-preview";

function saveConfig() {
  Bun.write(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
}

const HOME = process.env.HOME || "/root";
const CLAUDE_BIN = Bun.which("claude") || `${HOME}/.local/bin/claude`;

// --- Gemini voice transcription ---

async function transcribeVoice(oggData: Buffer, recentMessages: string[]): Promise<string> {
  const contextHint = recentMessages.length > 0
    ? `\n\nRecent conversation for context (use this to disambiguate technical terms):\n${recentMessages.join("\n")}`
    : "";

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.gemini_model}:generateContent?key=${cfg.gemini_api_key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: "You are a transcription service for a software engineering conversation. The speaker is discussing code, programming, and technical topics. Preserve technical terms, function names, variable names, CLI commands, and programming jargon accurately. Output ONLY the transcription, nothing else." }],
        },
        generationConfig: {
          thinkingConfig: { thinkingLevel: "low" },
        },
        contents: [{
          parts: [
            { text: `Transcribe this voice message:${contextHint}` },
            { inlineData: { mimeType: "audio/ogg", data: oggData.toString("base64") } },
          ],
        }],
      }),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const json = (await resp.json()) as any;
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "(empty transcription)";
}

// --- Claude via CLI (streaming NDJSON) ---

function makeClaudeEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// --- Markdown to Telegram HTML ---

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToTelegramHtml(md: string): string {
  let out = md;
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`;
  });
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  out = out.replace(/__(.+?)__/g, "<b>$1</b>");
  out = out.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
  out = out.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");
  out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  return out;
}

function splitMessage(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) { chunks.push(remaining); break; }
    let i = remaining.lastIndexOf("\n", max);
    if (i < max / 2) i = remaining.lastIndexOf(" ", max);
    if (i < max / 2) i = max;
    chunks.push(remaining.slice(0, i));
    remaining = remaining.slice(i).trimStart();
  }
  return chunks;
}

async function sendResponse(ctx: any, response: string, silent = true) {
  const html = markdownToTelegramHtml(response);
  for (const chunk of splitMessage(html)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML", disable_notification: silent });
    } catch {
      await ctx.reply(chunk, { disable_notification: silent });
    }
  }
}

// --- Per-chat state with long-lived Claude process ---

interface ChatState {
  botName: string;
  cwd: string;
  sessionId: string | undefined;
  history: string[];
  realtime: boolean;
  // Long-lived Claude process
  child: ReturnType<typeof Bun.spawn> | null;
  responding: boolean; // true while Claude is generating a response
  typingInterval: ReturnType<typeof setInterval> | null;
  turnStart: number;
  ctx: any; // latest telegram context for sending replies
}

const chatStates = new Map<string, ChatState>();

function getState(key: string, botName: string, cwd: string): ChatState {
  let s = chatStates.get(key);
  if (!s) {
    s = {
      botName, cwd,
      sessionId: cfg.bots[botName]?.session_id,
      history: [],
      realtime: true,
      child: null,
      responding: false,
      typingInterval: null,
      turnStart: 0,
      ctx: null,
    };
    chatStates.set(key, s);
  }
  return s;
}

function startTyping(state: ChatState) {
  if (state.typingInterval) return;
  state.ctx?.replyWithChatAction("typing").catch(() => {});
  state.typingInterval = setInterval(() => {
    state.ctx?.replyWithChatAction("typing").catch(() => {});
  }, 4000);
}

function stopTyping(state: ChatState) {
  if (state.typingInterval) {
    clearInterval(state.typingInterval);
    state.typingInterval = null;
  }
}

function killProcess(state: ChatState) {
  stopTyping(state);
  if (state.child) {
    try { state.child.kill(); } catch {}
    state.child = null;
  }
  state.responding = false;
}

// Spawn a long-lived Claude process with streaming input/output
function ensureClaudeProcess(key: string, state: ChatState, tag: string) {
  // Check if the existing child is still alive
  if (state.child && state.child.exitCode !== null) {
    console.log(`${tag} Claude process already exited (code ${state.child.exitCode}), respawning`);
    state.child = null;
  }
  if (state.child) return;

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model", "claude-opus-4-6",
  ];
  if (state.sessionId) {
    args.push("--resume", state.sessionId);
  }

  console.log(`${tag} spawning Claude process${state.sessionId ? ` (resume ${state.sessionId.slice(0, 8)}...)` : " (new)"}`);

  const child = Bun.spawn([CLAUDE_BIN, ...args], {
    cwd: state.cwd,
    env: makeClaudeEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  state.child = child;

  // Background: read stderr
  new Response(child.stderr).text().then(stderr => {
    if (stderr.trim()) console.error(`${tag} stderr: ${stderr.slice(0, 500)}`);
  });

  // Background: read stdout NDJSON events
  readClaudeOutput(key, state, tag, child);

  // Handle process exit
  child.exited.then(code => {
    console.log(`${tag} Claude process exited (code ${code})`);
    if (state.child === child) {
      state.child = null;
      if (state.responding) {
        state.responding = false;
        stopTyping(state);
        if (code !== 0) {
          state.ctx?.reply(`Error: Claude process exited with code ${code}`).catch(() => {});
        }
      }
    }
  });
}

async function readClaudeOutput(key: string, state: ChatState, tag: string, child: ReturnType<typeof Bun.spawn>) {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const textMessages: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        try {
          const ev = JSON.parse(line);
          console.log(`${tag} ev: ${line.slice(0, 500)}`);

          if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
            state.sessionId = ev.session_id;
            cfg.bots[state.botName]!.session_id = ev.session_id;
            saveConfig();
            console.log(`${tag} session: ${ev.session_id.slice(0, 8)}...`);
          }

          if (ev.type === "assistant" && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === "text" && block.text?.trim()) {
                const text = block.text.trim();
                textMessages.push(text);
                console.log(`${tag} text: ${text.slice(0, 200)}`);

                if (state.realtime && state.ctx) {
                  await sendResponse(state.ctx, text);
                }
              }
            }
          }

          if (ev.type === "result") {
            if (ev.session_id) {
              state.sessionId = ev.session_id;
              cfg.bots[state.botName]!.session_id = ev.session_id;
              saveConfig();
            }

            // Claude finished this turn — flush buffered messages
            stopTyping(state);
            state.responding = false;

            if (!state.realtime && state.ctx) {
              for (const text of textMessages) {
                await sendResponse(state.ctx, text);
                await Bun.sleep(100);
              }
            }

            const elapsed = ((Date.now() - state.turnStart) / 1000).toFixed(1);
            const allText = textMessages.join("\n\n");
            if (allText) {
              state.history.push(`Assistant: ${allText.slice(0, 300)}`);
            } else {
              state.history.push(`Assistant: [no text]`);
            }
            if (state.history.length > 10) state.history.splice(0, state.history.length - 10);

            console.log(`${tag} <- claude (${elapsed}s): ${allText ? allText.slice(0, 200) : "[no text]"}`);
            if (state.ctx) {
              await state.ctx.reply(`Done (${elapsed}s)`);
            }

            textMessages.length = 0;
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error(`${tag} stdout read error:`, err);
  }
}

function sendUserMessage(key: string, state: ChatState, text: string, ctx: any) {
  const tag = `[${state.botName}:${key.split(":")[1]}]`;
  state.ctx = ctx;

  state.history.push(`User: ${text.slice(0, 300)}`);
  if (state.history.length > 10) state.history.splice(0, state.history.length - 10);

  ensureClaudeProcess(key, state, tag);

  if (!state.child) {
    ctx.reply("Error: failed to start Claude process").catch(() => {});
    return;
  }

  const msg = JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  }) + "\n";

  console.log(`${tag} <- user: ${text.slice(0, 200)}`);
  console.log(`${tag} -> claude stdin (child alive: ${state.child.exitCode === null})`);

  try {
    state.child.stdin.write(msg);
    state.child.stdin.flush();
  } catch (err) {
    console.error(`${tag} stdin write error:`, err);
    killProcess(state);
    // Retry once with a fresh process
    console.log(`${tag} retrying with fresh process`);
    ensureClaudeProcess(key, state, tag);
    if (!state.child) {
      ctx.reply("Error: failed to start Claude process").catch(() => {});
      return;
    }
    try {
      state.child.stdin.write(msg);
      state.child.stdin.flush();
    } catch (err2) {
      console.error(`${tag} stdin write error on retry:`, err2);
      killProcess(state);
      ctx.reply("Error: failed to send message to Claude").catch(() => {});
      return;
    }
  }

  state.responding = true;
  state.turnStart = Date.now();
  startTyping(state);
}

// --- Cleanup on exit ---

function killAllProcesses() {
  for (const state of chatStates.values()) {
    if (state.child) {
      try { state.child.kill(); } catch {}
    }
  }
}

process.on("SIGINT", () => { killAllProcesses(); process.exit(0); });
process.on("SIGTERM", () => { killAllProcesses(); process.exit(0); });
process.on("exit", killAllProcesses);

// --- Bots ---

for (const [name, botCfg] of Object.entries(cfg.bots)) {
  const bot = new Bot(botCfg.token);

  bot.command("new", (ctx) => {
    const key = `${name}:${ctx.chat.id}`;
    const state = getState(key, name, botCfg.cwd);
    killProcess(state);
    state.sessionId = undefined;
    state.history = [];
    ctx.reply("Starting a new chat.");
  });

  bot.command("realtime", (ctx) => {
    const key = `${name}:${ctx.chat.id}`;
    const state = getState(key, name, botCfg.cwd);
    state.realtime = !state.realtime;
    ctx.reply(`Realtime mode: ${state.realtime ? "on" : "off"}`);
  });

  bot.on("message:voice", async (ctx) => {
    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${botCfg.token}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      const oggData = Buffer.from(await resp.arrayBuffer());

      console.log(`[${name}:${ctx.chat.id}] <- user: [voice message]`);
      const key = `${name}:${ctx.chat.id}`;
      const state = getState(key, name, botCfg.cwd);
      const transcription = await transcribeVoice(oggData, state.history.slice(-10));
      console.log(`[${name}:${ctx.chat.id}] transcribed: ${transcription.slice(0, 200)}`);

      await ctx.reply(`🎤 ${transcription}`);

      sendUserMessage(key, state, transcription, ctx);
    } catch (err) {
      console.error(`[${name}] Voice error:`, err);
      await ctx.reply(`Voice error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.on("message:text", (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const key = `${name}:${ctx.chat.id}`;
    const state = getState(key, name, botCfg.cwd);
    sendUserMessage(key, state, text, ctx);
  });

  bot.catch((err) => console.error(`[${name}]`, err));
  bot.start();
  console.log(`[${name}] Bot started`);
}
