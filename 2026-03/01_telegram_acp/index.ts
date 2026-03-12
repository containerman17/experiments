import { Bot, InlineKeyboard } from "grammy";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import yaml from "js-yaml";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// --- Config ---

interface Config {
    token: string;
    gemini_api_key: string;
    gemini_model?: string;
    user_id: number;
    agent_bin: string;
    active_session?: { id: string; cwd: string };
}

const configIdx = process.argv.indexOf("--config");
const CONFIG_PATH: string =
    configIdx !== -1 && process.argv[configIdx + 1]
        ? process.argv[configIdx + 1]!
        : "config.yaml";
const cfg = yaml.load(readFileSync(CONFIG_PATH, "utf-8")) as Config;
cfg.gemini_model = cfg.gemini_model || "gemini-3.1-pro-preview";

if (!cfg.token) { console.error("No 'token' in config."); process.exit(1); }
if (!cfg.user_id) { console.error("No 'user_id' in config."); process.exit(1); }
if (!cfg.agent_bin) { console.error("No 'agent_bin' in config."); process.exit(1); }

const HOME = process.env.HOME || "/root";
const AGENT_BIN = cfg.agent_bin;
const MAX_LAST_MESSAGES = 6;
const BOT_COMMANDS = [
    { command: "resume", description: "List recent ACP sessions and resume one" },
    { command: "new", description: "Create a new ACP session for a directory" },
] as const;

// --- Utilities ---

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

function timeAgo(iso: string): string {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
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

function shortCwd(cwd: string): string {
    return cwd.startsWith(HOME) ? "~" + cwd.slice(HOME.length) : cwd;
}

// --- Session history from disk ---

function getLastAssistantMessage(sessionId: string, cwd: string): string | null {
    const projectDir = cwd.replace(/\//g, "-");
    const file = join(HOME, ".claude", "projects", projectDir, `${sessionId}.jsonl`);
    if (!existsSync(file)) return null;

    const content = readFileSync(file, "utf-8");
    const lines = content.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const msg = JSON.parse(lines[i]!);
            if (msg.type === "assistant") {
                const texts = (msg.message?.content || [])
                    .filter((b: any) => b.type === "text")
                    .map((b: any) => b.text);
                if (texts.length) return texts.join("\n").slice(0, 500);
            }
        } catch {}
    }
    return null;
}

// --- Runtime state ---

let activeSessionId: string | null = cfg.active_session?.id || null;
let activeSessionCwd: string | null = cfg.active_session?.cwd || null;
if (activeSessionId) console.log(`Restored session ${activeSessionId.slice(0, 8)} in ${activeSessionCwd}`);

let activeChild: ChildProcess | null = null;
let activeConnection: acp.ClientSideConnection | null = null;
let sessionResumed = false; // whether we've resumed on the current connection

let typingInterval: ReturnType<typeof setInterval> | null = null;
let typingCount = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT = 60_000; // 1 minute
const sessionMessages = new Map<string, string[]>();
const callbackDataMap = new Map<string, { sessionId: string; cwd: string; title?: string }>();

// --- Persist active session ---

function saveActiveSession() {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = yaml.load(raw) as Record<string, any>;
    if (activeSessionId && activeSessionCwd) {
        config.active_session = { id: activeSessionId, cwd: activeSessionCwd };
    } else {
        delete config.active_session;
    }
    writeFileSync(CONFIG_PATH, yaml.dump(config));
}

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

// --- Telegram helpers ---

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

async function sendHtml(chatId: number, html: string, bot: Bot) {
    for (const chunk of splitMessage(html)) {
        try {
            await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML", disable_notification: true });
        } catch {
            await bot.api.sendMessage(chatId, chunk, { disable_notification: true });
        }
    }
}

function startTyping(chatId: number, bot: Bot) {
    typingCount++;
    if (typingInterval) return;
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    typingInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
}

function stopTyping() {
    typingCount = Math.max(0, typingCount - 1);
    if (typingCount === 0 && typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
    }
}

async function syncTelegramCommands(bot: Bot) {
    const current = await bot.api.getMyCommands();
    const expected = BOT_COMMANDS.map(({ command, description }) => ({ command, description }));
    const matches =
        current.length === expected.length &&
        current.every((cmd, index) => cmd.command === expected[index]!.command && cmd.description === expected[index]!.description);
    if (matches) return;
    await bot.api.setMyCommands(expected);
    console.log(`Updated Telegram bot commands: ${expected.map(cmd => `/${cmd.command}`).join(", ")}`);
}

async function downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${cfg.token}/${filePath}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
}

// --- ACP connection management ---
// We keep a persistent connection to the agent process. It stays alive across
// multiple prompts so we can fire messages concurrently.

function makeClaudeEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
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

function killAgent() {
    typingCount = 0;
    stopTyping();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    activeConnection = null;
    sessionResumed = false;
    if (activeChild) {
        console.log("Killing agent process");
        try { activeChild.kill(); } catch {}
        activeChild = null;
    }
}

function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (activeChild) {
            console.log("Idle timeout — killing agent process");
            killAgent();
        }
    }, IDLE_TIMEOUT);
}

// Ensure we have a live connection + resumed session. Reuses existing if alive.
async function ensureConnection(sessionId: string, cwd: string, bot: Bot, chatId: number): Promise<acp.ClientSideConnection> {
    // Reuse existing connection if it matches and is alive
    if (activeConnection && activeChild && !activeChild.killed && sessionResumed) {
        return activeConnection;
    }

    // Kill stale connection
    killAgent();

    console.log(`Spawning ${AGENT_BIN} in ${cwd} for session ${sessionId.slice(0, 8)}...`);

    const child = spawn(AGENT_BIN, [], {
        cwd,
        env: makeClaudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.error(`stderr: ${text.slice(0, 500)}`);
    });

    child.on("exit", (code) => {
        console.log(`ACP agent exited (code ${code})`);
        if (activeChild === child) {
            activeChild = null;
            activeConnection = null;
            sessionResumed = false;
        }
    });

    const input = Writable.toWeb(child.stdin! as any);
    const output = Readable.toWeb(child.stdout! as any) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const client: acp.Client = {
        async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
            const allowOption = params.options.find(o => (o.kind as string) === "allow_all" || (o.kind as string) === "allow");
            return {
                outcome: {
                    outcome: "selected",
                    optionId: allowOption?.optionId || params.options[0]!.optionId,
                },
            };
        },
        async sessionUpdate(params: acp.SessionNotification): Promise<void> {
            // Handled per-prompt via the onSessionUpdate callback below
            if ((connection as any)._onSessionUpdate) {
                await (connection as any)._onSessionUpdate(params);
            }
        },
        async writeTextFile(): Promise<acp.WriteTextFileResponse> { return {}; },
        async readTextFile(): Promise<acp.ReadTextFileResponse> { return { content: "" }; },
    };

    const connection = new acp.ClientSideConnection((_agent) => client, stream);

    await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
    });

    await connection.unstable_resumeSession({ sessionId, cwd });

    activeChild = child;
    activeConnection = connection;
    sessionResumed = true;
    resetIdleTimer();

    return connection;
}

// Send a prompt to the agent. Can be called concurrently — each call gets its
// own text accumulator and sends its own response to Telegram when done.
async function sendToAgent(
    sessionId: string,
    cwd: string,
    prompt: acp.ContentBlock[],
    chatId: number,
    bot: Bot,
) {
    const textSummary = prompt
        .filter((b): b is acp.ContentBlock & { type: "text" } => b.type === "text")
        .map(b => b.text)
        .join(" ") || "(image)";
    addMessage(sessionId, "User", textSummary);

    startTyping(chatId, bot);
    const turnStart = Date.now();

    try {
        const connection = await ensureConnection(sessionId, cwd, bot, chatId);

        // Collect text chunks for this specific prompt
        let responseText = "";
        const prevHandler = (connection as any)._onSessionUpdate;
        (connection as any)._onSessionUpdate = async (params: acp.SessionNotification) => {
            const update = params.update;
            if (update.sessionUpdate === "agent_message_chunk") {
                if (update.content.type === "text") {
                    responseText += update.content.text;
                }
            }
            // Chain to previous handler (for concurrent prompts)
            if (prevHandler) await prevHandler(params);
        };

        const result = await connection.prompt({ sessionId, prompt });

        // Restore previous handler
        (connection as any)._onSessionUpdate = prevHandler;

        stopTyping();

        if (responseText.trim()) {
            await sendTelegram(chatId, responseText.trim(), bot);
            addMessage(sessionId, "Assistant", responseText.trim());
        }

        const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
        let doneMsg = `Done (${elapsed}s) | ${result.stopReason}`;
        const usage = (result as any).usage;
        if (usage) {
            const used = (usage.inputTokens || 0) + (usage.outputTokens || 0);
            if (used > 0) doneMsg += ` | ${(used / 1000).toFixed(1)}k tokens`;
        }
        await bot.api.sendMessage(chatId, doneMsg);
        resetIdleTimer();
    } catch (err) {
        stopTyping();
        console.error("ACP prompt error:", err);
        // If connection died, clear it so next message respawns
        killAgent();
        await bot.api.sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// --- Temporary ACP connection (for listing/creating sessions) ---

async function withTempAgent<T>(cwd: string, fn: (connection: acp.ClientSideConnection) => Promise<T>): Promise<T> {
    const child = spawn(AGENT_BIN, [], {
        cwd,
        env: makeClaudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.error(`stderr: ${text.slice(0, 500)}`);
    });

    const input = Writable.toWeb(child.stdin! as any);
    const output = Readable.toWeb(child.stdout! as any) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const client: acp.Client = {
        async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
            return { outcome: { outcome: "selected", optionId: params.options[0]!.optionId } };
        },
        async sessionUpdate(): Promise<void> {},
        async writeTextFile(): Promise<acp.WriteTextFileResponse> { return {}; },
        async readTextFile(): Promise<acp.ReadTextFileResponse> { return { content: "" }; },
    };

    const connection = new acp.ClientSideConnection((_agent) => client, stream);
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    try {
        return await fn(connection);
    } finally {
        try { child.kill(); } catch {}
    }
}

// --- Cleanup ---

process.on("SIGINT", () => { killAgent(); process.exit(0); });
process.on("SIGTERM", () => { killAgent(); process.exit(0); });
process.on("exit", () => killAgent());

// --- Bot ---

const bot = new Bot(cfg.token);

// Log incoming messages
bot.use((ctx, next) => {
    const text = ctx.message?.text || ctx.message?.caption || ctx.callbackQuery?.data || "";
    const type = ctx.message?.voice ? "voice" : ctx.message?.photo ? "photo" : ctx.message?.document ? "doc" : ctx.callbackQuery ? "callback" : "text";
    if (text || type !== "text") console.log(`← [${type}] ${text.slice(0, 200)}`);
    return next();
});

// Auth gate
bot.use((ctx, next) => {
    if (ctx.from?.id !== cfg.user_id) {
        console.log(`Rejected user ${ctx.from?.id} (authorized: ${cfg.user_id})`);
        return;
    }
    return next();
});

// /resume — list sessions, show as inline buttons grouped by folder
bot.command("resume", async (ctx) => {
    try {
        startTyping(ctx.chat.id, bot);
        const sessions = await withTempAgent(HOME, (conn) => conn.listSessions({}));
        stopTyping();

        const sorted = (sessions.sessions || [])
            .filter(s => s.updatedAt)
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
            .slice(0, 15);

        if (sorted.length === 0) {
            await ctx.reply("No sessions found. Use /new <directory> to create one.");
            return;
        }

        // Group by cwd
        const groups = new Map<string, typeof sorted>();
        for (const s of sorted) {
            let group = groups.get(s.cwd);
            if (!group) { group = []; groups.set(s.cwd, group); }
            group.push(s);
        }

        const lines: string[] = [];
        const keyboard = new InlineKeyboard();
        let idx = 0;

        for (const [cwd, items] of groups) {
            lines.push(`\n📂 <b>${escapeHtml(shortCwd(cwd))}</b>`);
            for (const s of items) {
                idx++;
                const title = s.title || "(untitled)";
                lines.push(`  ${idx}. ${escapeHtml(title)} · ${timeAgo(s.updatedAt!)}`);
                const cbKey = `r:${idx}`;
                callbackDataMap.set(cbKey, { sessionId: s.sessionId, cwd: s.cwd, title: s.title });
                keyboard.text(String(idx), cbKey);
            }
            lines.push("");
            keyboard.row();
        }

        const listHtml = lines.join("\n");
        const chunks = splitMessage(listHtml);
        for (let i = 0; i < chunks.length - 1; i++) {
            await bot.api.sendMessage(ctx.chat!.id, chunks[i]!, { parse_mode: "HTML" });
        }
        await bot.api.sendMessage(ctx.chat!.id, chunks[chunks.length - 1]! + "\n\nPick a session:", { parse_mode: "HTML", reply_markup: keyboard });
    } catch (err) {
        stopTyping();
        console.error("List sessions error:", err);
        await ctx.reply(`Error listing sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// Handle resume button press
bot.callbackQuery(/^r:.+$/, async (ctx) => {
    const entry = callbackDataMap.get(ctx.callbackQuery.data);
    if (!entry) { await ctx.answerCallbackQuery({ text: "Session expired, use /resume again" }); return; }
    const { sessionId, cwd, title } = entry;

    // Kill old connection if switching sessions
    if (activeSessionId !== sessionId) killAgent();

    activeSessionId = sessionId;
    activeSessionCwd = cwd;
    saveActiveSession();

    const displayTitle = title || cwd.split("/").filter(Boolean).pop() || cwd;
    await ctx.answerCallbackQuery({ text: `Resumed: ${displayTitle}`.slice(0, 200) });

    let html = `✅ <b>${escapeHtml(displayTitle)}</b>\n<code>${escapeHtml(shortCwd(cwd))}</code>`;
    const lastMsg = getLastAssistantMessage(sessionId, cwd);
    if (lastMsg) {
        html += `\n\n<i>Last message:</i>\n${markdownToTelegramHtml(lastMsg)}`;
    }

    if (html.length <= 4096) {
        await ctx.editMessageText(html, { parse_mode: "HTML" });
    } else {
        try { await ctx.deleteMessage(); } catch {}
        await sendHtml(ctx.chat!.id, html, bot);
    }
});

// /new <directory>
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

    killAgent();
    startTyping(ctx.chat.id, bot);

    try {
        const sessionResult = await withTempAgent(dir, (conn) => conn.newSession({ cwd: dir, mcpServers: [] }));
        const sessionId = sessionResult.sessionId;

        activeSessionId = sessionId;
        activeSessionCwd = dir;
        saveActiveSession();
        stopTyping();

        const name = dir.split("/").filter(Boolean).pop() || "unnamed";
        await ctx.reply(
            `Session created: <b>${escapeHtml(name)}</b>\nDirectory: <code>${escapeHtml(dir)}</code>\nSession: <code>${sessionId.slice(0, 12)}...</code>\n\nSend a message to start.`,
            { parse_mode: "HTML" },
        );
    } catch (err) {
        stopTyping();
        console.error("New session error:", err);
        await ctx.reply(`Error creating session: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// Voice messages — transcribe immediately, then send to agent
bot.on("message:voice", async (ctx) => {
    if (!activeSessionId || !activeSessionCwd) {
        await ctx.reply("No active session. Use /resume to pick one.");
        return;
    }

    const sessionId = activeSessionId;
    const cwd = activeSessionCwd;

    try {
        startTyping(ctx.chat.id, bot);
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
        stopTyping();

        await ctx.reply(`Voice (${voiceSec}s): ${transcription}`);

        if (!activeSessionId || !activeSessionCwd) return;

        // Fire and forget — don't await so we can handle the next message immediately
        sendToAgent(sessionId, cwd, [{ type: "text", text: transcription }], ctx.chat.id, bot);
    } catch (err) {
        stopTyping();
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

    // Fire and forget
    sendToAgent(activeSessionId, activeSessionCwd, [{ type: "text", text }], ctx.chat.id, bot);
});

// Photo messages
bot.on("message:photo", async (ctx) => {
    if (!activeSessionId || !activeSessionCwd) {
        await ctx.reply("No active session. Use /resume to pick one.");
        return;
    }

    try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1]!;
        const file = await ctx.api.getFile(largest.file_id);
        const imageData = await downloadTelegramFile(file.file_path!);

        const prompt: acp.ContentBlock[] = [];
        const caption = ctx.message.caption?.trim();
        prompt.push({ type: "text", text: caption || "Here's an image:" });
        prompt.push({ type: "image", data: imageData.toString("base64"), mimeType: "image/jpeg" });

        sendToAgent(activeSessionId, activeSessionCwd, prompt, ctx.chat.id, bot);
    } catch (err) {
        console.error("Photo error:", err);
        await ctx.reply(`Photo error: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// Document images
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.mime_type || !IMAGE_MIME_TYPES.has(doc.mime_type)) return;

    if (!activeSessionId || !activeSessionCwd) {
        await ctx.reply("No active session. Use /resume to pick one.");
        return;
    }

    try {
        const file = await ctx.api.getFile(doc.file_id);
        const imageData = await downloadTelegramFile(file.file_path!);

        const prompt: acp.ContentBlock[] = [];
        const caption = ctx.message.caption?.trim();
        prompt.push({ type: "text", text: caption || "Here's an image:" });
        prompt.push({ type: "image", data: imageData.toString("base64"), mimeType: doc.mime_type });

        sendToAgent(activeSessionId, activeSessionCwd, prompt, ctx.chat.id, bot);
    } catch (err) {
        console.error("Document image error:", err);
        await ctx.reply(`Image error: ${err instanceof Error ? err.message : String(err)}`);
    }
});

bot.catch((err) => console.error("Bot error:", err));

// Log outgoing messages
bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === "sendMessage" && (payload as any)?.text) {
        console.log(`→ [${method}] ${String((payload as any).text).slice(0, 200)}`);
    }
    return prev(method, payload, signal);
});

await syncTelegramCommands(bot);
await bot.start();
console.log("Telegram ACP bot started (single-user mode)");
