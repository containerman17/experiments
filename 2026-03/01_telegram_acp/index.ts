import { Bot, InlineKeyboard } from "grammy";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import yaml from "js-yaml";

// --- Config ---

interface Config {
    token: string;
    gemini_api_key: string;
    gemini_model?: string;
    user_id: number;
    claude_bin?: string;
}

const configIdx = process.argv.indexOf("--config");
const CONFIG_PATH: string =
    configIdx !== -1 && process.argv[configIdx + 1]
        ? process.argv[configIdx + 1]!
        : "config.yaml";
const cfg = yaml.load(await Bun.file(CONFIG_PATH).text()) as Config;
cfg.gemini_model = cfg.gemini_model || "gemini-3.1-pro-preview";

if (!cfg.token) { console.error("No 'token' in config."); process.exit(1); }
if (!cfg.user_id) { console.error("No 'user_id' in config."); process.exit(1); }

const HOME = process.env.HOME || "/root";
const CLAUDE_BIN = cfg.claude_bin || `${HOME}/.local/bin/claude`;
const MAX_LAST_MESSAGES = 6;

// --- Runtime state ---

let activeSessionId: string | null = null;
let activeSessionCwd: string | null = null;
let activeChild: ReturnType<typeof Bun.spawn> | null = null;
let activeConnection: acp.ClientSideConnection | null = null;
let responding = false;
let typingInterval: ReturnType<typeof setInterval> | null = null;
let turnStart = 0;
// In-memory message history for voice context and recap
const sessionMessages = new Map<string, string[]>();

// --- Gemini voice transcription ---

async function transcribeVoice(oggData: Buffer, context: string): Promise<string> {
    const contextHint = context
        ? `\n\nRecent conversation for context (use this to disambiguate technical terms):\n${context}`
        : "";

    const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.gemini_model}:generateContent?key=${cfg.gemini_api_key}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(60000),
            body: JSON.stringify({
                system_instruction: {
                    parts: [{
                        text: "You are a transcription service for a software engineering conversation. The speaker is discussing code, programming, and technical topics. Preserve technical terms, function names, variable names, CLI commands, and programming jargon accurately. Output ONLY the transcription, nothing else.",
                    }],
                },
                generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
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

async function sendTelegram(chatId: number, response: string, bot: Bot) {
    const html = markdownToTelegramHtml(response);
    for (const chunk of splitMessage(html)) {
        try {
            await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML", disable_notification: true });
        } catch {
            await bot.api.sendMessage(chatId, chunk, { disable_notification: true });
        }
    }
}

// --- Process & ACP management ---

function makeClaudeEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
}

function startTyping(chatId: number, bot: Bot) {
    if (typingInterval) return;
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    typingInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
}

function stopTyping() {
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
}

function killProcess() {
    stopTyping();
    activeConnection = null;
    if (activeChild) {
        try { activeChild.kill(); } catch {}
        activeChild = null;
    }
    responding = false;
}

function addMessage(sessionId: string, role: "User" | "Assistant", text: string) {
    let msgs = sessionMessages.get(sessionId);
    if (!msgs) { msgs = []; sessionMessages.set(sessionId, msgs); }
    msgs.push(`${role}: ${text.slice(0, 500)}`);
    if (msgs.length > MAX_LAST_MESSAGES) msgs.splice(0, msgs.length - MAX_LAST_MESSAGES);
}

function getSessionContext(sessionId: string): string {
    const msgs = sessionMessages.get(sessionId);
    if (!msgs?.length) return "";
    const context = msgs.join("\n");
    return context.length > 5000 ? context.slice(-5000) : context;
}

// Spawn Claude as ACP agent and return connection
async function spawnAcpAgent(cwd: string): Promise<{ child: ReturnType<typeof Bun.spawn>; connection: acp.ClientSideConnection }> {
    const child = Bun.spawn([CLAUDE_BIN], {
        cwd,
        env: makeClaudeEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    new Response(child.stderr).text().then((stderr) => {
        if (stderr.trim()) console.error(`stderr: ${stderr.slice(0, 500)}`);
    });

    const input = Writable.toWeb(child.stdin! as any);
    const output = Readable.toWeb(child.stdout! as any) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    let sessionUpdateHandler: ((params: acp.SessionNotification) => Promise<void>) | null = null;

    const client: acp.Client = {
        async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
            // Auto-approve everything (dangerously-skip-permissions equivalent)
            const allowOption = params.options.find(o => o.kind === "allow_all" || o.kind === "allow");
            return {
                outcome: {
                    outcome: "selected",
                    optionId: allowOption?.optionId || params.options[0]!.optionId,
                },
            };
        },
        async sessionUpdate(params: acp.SessionNotification): Promise<void> {
            if (sessionUpdateHandler) await sessionUpdateHandler(params);
        },
        async writeTextFile(): Promise<acp.WriteTextFileResponse> { return {}; },
        async readTextFile(): Promise<acp.ReadTextFileResponse> { return { content: "" }; },
    };

    const connection = new acp.ClientSideConnection((_agent) => client, stream);

    // Initialize
    await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
    });

    // Expose a way to set the session update handler
    (connection as any)._setSessionUpdateHandler = (handler: typeof sessionUpdateHandler) => {
        sessionUpdateHandler = handler;
    };

    return { child, connection };
}

// List sessions via ACP session/list
async function listSessionsViaAcp(cwd?: string): Promise<acp.SessionInfo[]> {
    // Spawn a temporary agent just to list sessions
    const listCwd = cwd || HOME;
    const { child, connection } = await spawnAcpAgent(listCwd);

    try {
        const result = await connection.listSessions({ cwd: cwd || undefined });
        return result.sessions || [];
    } finally {
        try { child.kill(); } catch {}
    }
}

// Send message to agent via ACP
async function sendToAgent(
    sessionId: string,
    cwd: string,
    text: string,
    chatId: number,
    bot: Bot,
) {
    addMessage(sessionId, "User", text);

    console.log(`Spawning ACP agent in ${cwd} for session ${sessionId.slice(0, 8)}...`);

    const { child, connection } = await spawnAcpAgent(cwd);
    activeChild = child;
    activeConnection = connection;

    // Set up session update handler to collect text
    const textChunks: string[] = [];
    let currentMessageText = "";

    (connection as any)._setSessionUpdateHandler(async (params: acp.SessionNotification) => {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
            if (update.content.type === "text") {
                currentMessageText += update.content.text;
            }
        }
    });

    responding = true;
    turnStart = Date.now();
    startTyping(chatId, bot);

    try {
        // Resume session
        await connection.unstable_resumeSession({
            sessionId,
            cwd,
        });

        // Send prompt
        const result = await connection.prompt({
            sessionId,
            prompt: [{ type: "text", text }],
        });

        stopTyping();
        responding = false;

        // Send collected text to Telegram
        if (currentMessageText.trim()) {
            await sendTelegram(chatId, currentMessageText.trim(), bot);
            addMessage(sessionId, "Assistant", currentMessageText.trim());
        }

        // Done message
        const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
        let doneMsg = `Done (${elapsed}s) | ${result.stopReason}`;
        // Usage info if available
        const usage = (result as any).usage;
        if (usage) {
            const used = (usage.inputTokens || 0) + (usage.outputTokens || 0);
            if (used > 0) {
                doneMsg += ` | ${(used / 1000).toFixed(1)}k tokens`;
            }
        }
        await bot.api.sendMessage(chatId, doneMsg);
    } catch (err) {
        stopTyping();
        responding = false;
        console.error("ACP prompt error:", err);
        await bot.api.sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        killProcess();
        activeSessionId = null;
        activeSessionCwd = null;
    }

    // Handle exit
    child.exited.then((code) => {
        console.log(`Claude process exited (code ${code})`);
    });
}

// --- Cleanup ---

process.on("SIGINT", () => { killProcess(); process.exit(0); });
process.on("SIGTERM", () => { killProcess(); process.exit(0); });
process.on("exit", () => killProcess());

// --- Bot ---

const bot = new Bot(cfg.token);

// Auth gate: single user only
bot.use((ctx, next) => {
    if (ctx.from?.id !== cfg.user_id) {
        console.log(`Rejected user ${ctx.from?.id} (authorized: ${cfg.user_id})`);
        return;
    }
    return next();
});

// /resume — list sessions via ACP, show as inline buttons
bot.command("resume", async (ctx) => {
    try {
        await ctx.reply("Loading sessions...");
        const sessions = await listSessionsViaAcp();

        if (sessions.length === 0) {
            await ctx.reply("No sessions found. Use /new <directory> to create one.");
            return;
        }

        // Sort by updatedAt descending, take last 5
        const sorted = sessions
            .filter(s => s.updatedAt)
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
            .slice(0, 5);

        if (sorted.length === 0) {
            await ctx.reply("No sessions with timestamps found.");
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const s of sorted) {
            const dirName = s.cwd.split("/").filter(Boolean).pop() || s.cwd;
            const title = s.title || dirName;
            const shortId = s.sessionId.slice(0, 8);
            const label = `${title} (${shortId}...)`;
            // Encode sessionId:cwd in callback data
            keyboard.text(label, `resume:${s.sessionId}:${s.cwd}`).row();
        }

        await ctx.reply("Pick a session to resume:", { reply_markup: keyboard });
    } catch (err) {
        console.error("List sessions error:", err);
        await ctx.reply(`Error listing sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// Handle inline button press for /resume
bot.callbackQuery(/^resume:([^:]+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match![1]!;
    const cwd = ctx.match![2]!;

    activeSessionId = sessionId;
    activeSessionCwd = cwd;

    const dirName = cwd.split("/").filter(Boolean).pop() || cwd;
    await ctx.answerCallbackQuery({ text: `Resumed: ${dirName}` });

    // Show recap from in-memory messages
    const msgs = sessionMessages.get(sessionId);
    if (msgs?.length) {
        const recap = msgs.slice(-3).map(m => `> ${m}`).join("\n\n");
        await ctx.editMessageText(
            `Resumed <b>${escapeHtml(dirName)}</b> in <code>${escapeHtml(cwd)}</code>\n\n${markdownToTelegramHtml(recap)}`,
            { parse_mode: "HTML" },
        );
    } else {
        await ctx.editMessageText(
            `Resumed <b>${escapeHtml(dirName)}</b> in <code>${escapeHtml(cwd)}</code>\n\nNo recent messages in memory.`,
            { parse_mode: "HTML" },
        );
    }
});

// /new <directory> — create a new session via ACP
bot.command("new", async (ctx) => {
    let dir = ctx.match?.trim() || "";
    if (!dir) { await ctx.reply("Usage: /new <directory>"); return; }

    if (dir.startsWith("~/")) dir = HOME + dir.slice(1);
    else if (dir === "~") dir = HOME;

    try {
        const stat = (await import("fs")).statSync(dir);
        if (!stat.isDirectory()) { await ctx.reply(`Not a directory: ${dir}`); return; }
    } catch {
        await ctx.reply(`Directory not found: ${dir}`);
        return;
    }

    killProcess();

    try {
        const { child, connection } = await spawnAcpAgent(dir);
        const sessionResult = await connection.newSession({ cwd: dir, mcpServers: [] });
        const sessionId = sessionResult.sessionId;

        try { child.kill(); } catch {}

        activeSessionId = sessionId;
        activeSessionCwd = dir;

        const name = dir.split("/").filter(Boolean).pop() || "unnamed";
        await ctx.reply(
            `Session created: <b>${escapeHtml(name)}</b>\nDirectory: <code>${escapeHtml(dir)}</code>\nSession: <code>${sessionId.slice(0, 12)}...</code>\n\nSend a message to start.`,
            { parse_mode: "HTML" },
        );
    } catch (err) {
        console.error("New session error:", err);
        await ctx.reply(`Error creating session: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
    if (!activeSessionId || !activeSessionCwd) {
        await ctx.reply("No active session. Use /resume to pick one.");
        return;
    }
    if (responding) {
        await ctx.reply("Agent is still responding. Please wait.");
        return;
    }

    const sessionId = activeSessionId;
    const cwd = activeSessionCwd;

    try {
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        const oggData = Buffer.from(await resp.arrayBuffer());

        const voiceStart = Date.now();
        console.log("Voice message received");
        const context = getSessionContext(sessionId);
        const transcription = await transcribeVoice(oggData, context);
        const voiceSec = ((Date.now() - voiceStart) / 1000).toFixed(1);
        console.log(`Transcribed (${voiceSec}s): ${transcription.slice(0, 200)}`);

        await ctx.reply(`Voice (${voiceSec}s): ${transcription}`);

        if (activeSessionId !== sessionId) {
            await ctx.reply("Session changed during transcription. Message not sent.");
            return;
        }

        await sendToAgent(sessionId, cwd, transcription, ctx.chat.id, bot);
    } catch (err) {
        console.error("Voice error:", err);
        await ctx.reply(`Voice error: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// Text messages
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    if (!activeSessionId || !activeSessionCwd) {
        await ctx.reply("No active session. Use /resume to pick one.");
        return;
    }
    if (responding) {
        await ctx.reply("Agent is still responding. Please wait.");
        return;
    }

    await sendToAgent(activeSessionId, activeSessionCwd, text, ctx.chat.id, bot);
});

bot.catch((err) => console.error("Bot error:", err));
bot.start();
console.log("Telegram ACP bot started (single-user mode)");
