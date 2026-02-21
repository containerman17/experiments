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
const CONFIG_PATH = configIdx !== -1 && process.argv[configIdx + 1] ? process.argv[configIdx + 1] : "config.yaml";
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

function formatToolCall(name: string, input: any): string {
  switch (name) {
    case "Read": return `Reading ${shortenPath(input?.file_path)}`;
    case "Edit": return `Editing ${shortenPath(input?.file_path)}`;
    case "Write": return `Writing ${shortenPath(input?.file_path)}`;
    case "Bash": return `$ ${(input?.command || "").slice(0, 80)}`;
    case "Glob": return `Searching for ${input?.pattern || "files"}`;
    case "Grep": return `Grepping "${(input?.pattern || "").slice(0, 40)}"`;
    case "Task": return `Delegating subtask`;
    default: return name;
  }
}

function shortenPath(p: string): string {
  if (!p) return "?";
  const parts = p.split("/");
  return parts.length > 3 ? `.../${parts.slice(-2).join("/")}` : p;
}

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

async function sendResponse(ctx: any, response: string) {
  const html = markdownToTelegramHtml(response);
  for (const chunk of splitMessage(html)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(chunk);
    }
  }
}

// --- Per-chat queue + session state ---

interface ChatState {
  botName: string;
  sessionId: string | undefined;
  queue: string[];
  processing: boolean;
  history: string[]; // last N messages for voice transcription context
}

const chatStates = new Map<string, ChatState>();

function getState(key: string, botName: string): ChatState {
  let s = chatStates.get(key);
  if (!s) {
    s = { botName, sessionId: cfg.bots[botName]?.session_id, queue: [], processing: false, history: [] };
    chatStates.set(key, s);
  }
  return s;
}

async function processQueue(key: string, name: string, chatId: number, cwd: string, ctx: any) {
  const state = getState(key, name);
  if (state.processing || state.queue.length === 0) return;
  state.processing = true;

  const prompt = state.queue.splice(0).join("\n\n");
  const tag = `[${name}:${chatId}]`;

  state.history.push(`User: ${prompt.slice(0, 300)}`);
  if (state.history.length > 10) state.history.splice(0, state.history.length - 10);

  console.log(`${tag} <- user: ${prompt.slice(0, 200)}`);
  console.log(`${tag} -> claude: ${prompt.slice(0, 200)}${state.sessionId ? ` (resume ${state.sessionId.slice(0, 8)}...)` : " (new)"}`);

  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  const t0 = Date.now();

  try {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--max-turns", "10",
      "--model", "claude-opus-4-6",
    ];
    if (state.sessionId) {
      args.push("--resume", state.sessionId);
    }

    const child = Bun.spawn([CLAUDE_BIN, ...args], { cwd, env: makeClaudeEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
    const stderrP = new Response(child.stderr).text();

    // Status message we keep editing with tool call updates
    const statusMsg = await ctx.reply("Working...");
    const toolLog: string[] = [];
    let lastEditTime = 0;
    let resultText = "";
    let sessionId = "";

    async function editStatus(text: string) {
      const now = Date.now();
      if (now - lastEditTime < 2000) return;
      lastEditTime = now;
      try { await ctx.api.editMessageText(chatId, statusMsg.message_id, text); } catch {}
    }

    // Read NDJSON line by line
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

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

          if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
            sessionId = ev.session_id;
          }

          if (ev.type === "assistant" && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === "tool_use") {
                const desc = formatToolCall(block.name, block.input);
                toolLog.push(desc);
                console.log(`${tag} tool: ${desc}`);
                const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                const recent = toolLog.slice(-5).join("\n");
                await editStatus(`Working... (${elapsed}s)\n${recent}`);
              }
            }
          }

          if (ev.type === "result") {
            resultText = ev.result || "";
            if (ev.session_id) sessionId = ev.session_id;
          }
        } catch {}
      }
    }

    const exitCode = await child.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      const stderr = await stderrP;
      throw new Error(`Claude exited ${exitCode}: ${stderr.slice(0, 200)}`);
    }

    if (sessionId) {
      state.sessionId = sessionId;
      cfg.bots[state.botName].session_id = sessionId;
      saveConfig();
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Edit status to "Done"
    const summary = toolLog.length > 0 ? toolLog.slice(-5).join("\n") : "";
    const doneMsg = summary ? `Done (${elapsed}s)\n${summary}` : `Done (${elapsed}s)`;
    try { await ctx.api.editMessageText(chatId, statusMsg.message_id, doneMsg); } catch {}

    // Send Claude's text response if it produced one
    if (resultText) {
      state.history.push(`Assistant: ${resultText.slice(0, 300)}`);
      if (state.history.length > 10) state.history.splice(0, state.history.length - 10);
      console.log(`${tag} <- claude (${elapsed}s): ${resultText.slice(0, 200)}`);
      await sendResponse(ctx, resultText);
    } else {
      state.history.push(`Assistant: [${toolLog.length} tool calls, no text]`);
      if (state.history.length > 10) state.history.splice(0, state.history.length - 10);
      console.log(`${tag} <- claude (${elapsed}s): [${toolLog.length} tool calls, no text]`);
    }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} !! claude error (${elapsed}s): ${msg}`);
    await ctx.reply(`Error: ${msg}`);
  } finally {
    clearInterval(typingInterval);
    state.processing = false;
    if (state.queue.length > 0) {
      processQueue(key, name, chatId, cwd, ctx);
    }
  }
}

// --- Bots ---

for (const [name, botCfg] of Object.entries(cfg.bots)) {
  const bot = new Bot(botCfg.token);

  bot.command("new", (ctx) => {
    const key = `${name}:${ctx.chat.id}`;
    const state = getState(key, name);
    state.sessionId = undefined;
    state.queue = [];
    ctx.reply("Starting a new chat.");
  });

  bot.on("message:voice", async (ctx) => {
    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${botCfg.token}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      const oggData = Buffer.from(await resp.arrayBuffer());

      console.log(`[${name}:${ctx.chat.id}] <- user: [voice message]`);
      const key = `${name}:${ctx.chat.id}`;
      const state = getState(key, name);
      const transcription = await transcribeVoice(oggData, state.history.slice(-10));
      console.log(`[${name}:${ctx.chat.id}] transcribed: ${transcription.slice(0, 200)}`);

      await ctx.reply(`🎤 ${transcription}`);

      state.queue.push(transcription);
      processQueue(key, name, ctx.chat.id, botCfg.cwd, ctx);
    } catch (err) {
      console.error(`[${name}] Voice error:`, err);
      await ctx.reply(`Voice error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.on("message:text", (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const key = `${name}:${ctx.chat.id}`;
    getState(key, name).queue.push(text);
    processQueue(key, name, ctx.chat.id, botCfg.cwd, ctx);
  });

  bot.catch((err) => console.error(`[${name}]`, err));
  bot.start();
  console.log(`[${name}] Bot started`);
}
