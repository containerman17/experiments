import { Bot, InlineKeyboard } from "grammy";
import yaml from "js-yaml";

// --- Config ---

interface SessionInfo {
    name: string;
    directory: string;
    last_messages: string[]; // last N messages for recap & voice context
}

interface Config {
    token: string;
    gemini_api_key: string;
    gemini_model?: string;
    user_id: number;
    active_session: string | null;
    sessions: Record<string, SessionInfo>;
}

const configIdx = process.argv.indexOf("--config");
const CONFIG_PATH: string =
    configIdx !== -1 && process.argv[configIdx + 1]
        ? process.argv[configIdx + 1]!
        : "config.yaml";
const cfg = yaml.load(await Bun.file(CONFIG_PATH).text()) as Config;
cfg.gemini_model = cfg.gemini_model || "gemini-3.1-pro-preview";
cfg.sessions = cfg.sessions || {};

if (!cfg.token) {
    console.error("No 'token' in config.");
    process.exit(1);
}
if (!cfg.user_id) {
    console.error("No 'user_id' in config.");
    process.exit(1);
}

function saveConfig() {
    Bun.write(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
}

const HOME = process.env.HOME || "/root";
const CLAUDE_BIN = `${HOME}/.local/bin/claude`;
const MAX_LAST_MESSAGES = 6; // 3 turns (user+assistant each)

// --- Runtime state ---

let activeChild: ReturnType<typeof Bun.spawn> | null = null;
let responding = false;
let typingInterval: ReturnType<typeof setInterval> | null = null;
let turnStart = 0;

// --- Gemini voice transcription ---

async function transcribeVoice(
    oggData: Buffer,
    context: string,
): Promise<string> {
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
                    parts: [
                        {
                            text: "You are a transcription service for a software engineering conversation. The speaker is discussing code, programming, and technical topics. Preserve technical terms, function names, variable names, CLI commands, and programming jargon accurately. Output ONLY the transcription, nothing else.",
                        },
                    ],
                },
                generationConfig: {
                    thinkingConfig: { thinkingLevel: "low" },
                },
                contents: [
                    {
                        parts: [
                            {
                                text: `Transcribe this voice message:${contextHint}`,
                            },
                            {
                                inlineData: {
                                    mimeType: "audio/ogg",
                                    data: oggData.toString("base64"),
                                },
                            },
                        ],
                    },
                ],
            }),
        },
    );

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error ${resp.status}: ${err}`);
    }

    const json = (await resp.json()) as any;
    return (
        json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
        "(empty transcription)"
    );
}

// --- Markdown to Telegram HTML ---

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function markdownToTelegramHtml(md: string): string {
    let out = md;
    out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
        const escaped = escapeHtml(code.trimEnd());
        return lang
            ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
            : `<pre>${escaped}</pre>`;
    });
    out = out.replace(
        /`([^`]+)`/g,
        (_m, code) => `<code>${escapeHtml(code)}</code>`,
    );
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
        if (remaining.length <= max) {
            chunks.push(remaining);
            break;
        }
        let i = remaining.lastIndexOf("\n", max);
        if (i < max / 2) i = remaining.lastIndexOf(" ", max);
        if (i < max / 2) i = max;
        chunks.push(remaining.slice(0, i));
        remaining = remaining.slice(i).trimStart();
    }
    return chunks;
}

async function sendResponse(chatId: number, response: string, bot: Bot) {
    const html = markdownToTelegramHtml(response);
    for (const chunk of splitMessage(html)) {
        try {
            await bot.api.sendMessage(chatId, chunk, {
                parse_mode: "HTML",
                disable_notification: true,
            });
        } catch {
            await bot.api.sendMessage(chatId, chunk, {
                disable_notification: true,
            });
        }
    }
}

// --- Claude process management ---

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
    if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
    }
}

function killProcess() {
    stopTyping();
    if (activeChild) {
        try {
            activeChild.kill();
        } catch {}
        activeChild = null;
    }
    responding = false;
}

function getSessionContext(sessionId: string): string {
    const session = cfg.sessions[sessionId];
    if (!session?.last_messages?.length) return "";
    const context = session.last_messages.join("\n");
    return context.length > 5000 ? context.slice(-5000) : context;
}

function addMessage(sessionId: string, role: "User" | "Assistant", text: string) {
    const session = cfg.sessions[sessionId];
    if (!session) return;
    session.last_messages = session.last_messages || [];
    session.last_messages.push(`${role}: ${text.slice(0, 500)}`);
    if (session.last_messages.length > MAX_LAST_MESSAGES) {
        session.last_messages.splice(0, session.last_messages.length - MAX_LAST_MESSAGES);
    }
    saveConfig();
}

async function sendToAgent(
    sessionId: string,
    text: string,
    chatId: number,
    bot: Bot,
) {
    const session = cfg.sessions[sessionId];
    if (!session) {
        await bot.api.sendMessage(chatId, "Session not found.");
        return;
    }

    // Record user message
    addMessage(sessionId, "User", text);

    // Spawn Claude process
    const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model", "claude-sonnet-4-6",
        "--resume", sessionId,
    ];

    console.log(`Spawning Claude in ${session.directory} (resume ${sessionId.slice(0, 8)}...)`);

    const child = Bun.spawn([CLAUDE_BIN, ...args], {
        cwd: session.directory,
        env: makeClaudeEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    activeChild = child;

    // Read stderr
    new Response(child.stderr).text().then((stderr) => {
        if (stderr.trim()) console.error(`stderr: ${stderr.slice(0, 500)}`);
    });

    // Send user message
    const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
    }) + "\n";

    try {
        child.stdin.write(msg);
        child.stdin.flush();
    } catch (err) {
        console.error("stdin write error:", err);
        killProcess();
        await bot.api.sendMessage(chatId, "Error: failed to send message to Claude.");
        return;
    }

    responding = true;
    turnStart = Date.now();
    startTyping(chatId, bot);

    // Read output
    readClaudeOutput(sessionId, chatId, bot, child);

    child.exited.then((code) => {
        console.log(`Claude process exited (code ${code})`);
        if (activeChild === child) {
            activeChild = null;
            if (responding) {
                responding = false;
                stopTyping();
                if (code !== 0) {
                    bot.api.sendMessage(chatId, `Error: Claude process exited with code ${code}`).catch(() => {});
                }
            }
        }
    });
}

async function readClaudeOutput(
    sessionId: string,
    chatId: number,
    bot: Bot,
    child: ReturnType<typeof Bun.spawn>,
) {
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
                    console.log(`ev: ${line.slice(0, 300)}`);

                    // Capture session ID on init
                    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
                        // Update session ID if it changed
                        if (ev.session_id !== sessionId && cfg.sessions[sessionId]) {
                            const session = cfg.sessions[sessionId]!;
                            cfg.sessions[ev.session_id] = session;
                            delete cfg.sessions[sessionId];
                            if (cfg.active_session === sessionId) {
                                cfg.active_session = ev.session_id;
                            }
                            saveConfig();
                        }
                    }

                    // Collect text messages
                    if (ev.type === "assistant" && ev.message?.content) {
                        for (const block of ev.message.content) {
                            if (block.type === "text" && block.text?.trim()) {
                                textMessages.push(block.text.trim());
                            }
                        }
                    }

                    // Turn complete
                    if (ev.type === "result") {
                        stopTyping();
                        responding = false;

                        // Send all text messages
                        for (const text of textMessages) {
                            await sendResponse(chatId, text, bot);
                            await Bun.sleep(100);
                        }

                        // Record assistant message
                        const allText = textMessages.join("\n\n");
                        if (allText) {
                            addMessage(cfg.active_session || sessionId, "Assistant", allText);
                        }

                        // Done message with usage
                        const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
                        let doneMsg = `Done (${elapsed}s)`;
                        const u = ev.usage;
                        const modelUsage = ev.modelUsage;
                        if (u && modelUsage) {
                            const model = Object.keys(modelUsage)[0];
                            const window = model ? modelUsage[model].contextWindow || 0 : 0;
                            const used =
                                (u.input_tokens || 0) +
                                (u.cache_read_input_tokens || 0) +
                                (u.cache_creation_input_tokens || 0) +
                                (u.output_tokens || 0);
                            if (window > 0) {
                                const pct = ((used / window) * 100).toFixed(1);
                                const usedK = (used / 1000).toFixed(1);
                                const windowK = (window / 1000).toFixed(0);
                                doneMsg += ` | context: ${usedK}k/${windowK}k (${pct}%)`;
                            }
                        }
                        await bot.api.sendMessage(chatId, doneMsg);

                        // Auto-detach: kill process
                        killProcess();
                        // Clear active session so next message requires /resume
                        cfg.active_session = null;
                        saveConfig();

                        textMessages.length = 0;
                    }
                } catch {}
            }
        }
    } catch (err) {
        console.error("stdout read error:", err);
    }
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

// /resume — list sessions as inline buttons
bot.command("resume", async (ctx) => {
    const sessionIds = Object.keys(cfg.sessions);
    if (sessionIds.length === 0) {
        await ctx.reply("No sessions. Use /new <directory> to create one.");
        return;
    }

    // Show last 5 sessions
    const recent = sessionIds.slice(-5);
    const keyboard = new InlineKeyboard();
    for (const id of recent) {
        const session = cfg.sessions[id]!;
        const shortId = id.slice(0, 8);
        const label = `${session.name} (${shortId}...)`;
        keyboard.text(label, `resume:${id}`).row();
    }

    await ctx.reply("Pick a session to resume:", { reply_markup: keyboard });
});

// Handle inline button press for /resume
bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
    const sessionId = ctx.match![1]!;
    const session = cfg.sessions[sessionId];
    if (!session) {
        await ctx.answerCallbackQuery({ text: "Session not found." });
        return;
    }

    cfg.active_session = sessionId;
    saveConfig();

    await ctx.answerCallbackQuery({ text: `Resumed: ${session.name}` });

    // Send recap: last messages
    if (session.last_messages?.length) {
        const recap = session.last_messages
            .slice(-3)
            .map((m) => `> ${m}`)
            .join("\n\n");
        await ctx.editMessageText(
            `Resumed <b>${escapeHtml(session.name)}</b> in <code>${escapeHtml(session.directory)}</code>\n\n${markdownToTelegramHtml(recap)}`,
            { parse_mode: "HTML" },
        );
    } else {
        await ctx.editMessageText(
            `Resumed <b>${escapeHtml(session.name)}</b> in <code>${escapeHtml(session.directory)}</code>`,
            { parse_mode: "HTML" },
        );
    }
});

// /new <directory> — create a new session
bot.command("new", async (ctx) => {
    let dir = ctx.match?.trim() || "";
    if (!dir) {
        await ctx.reply("Usage: /new <directory>");
        return;
    }

    if (dir.startsWith("~/")) dir = HOME + dir.slice(1);
    else if (dir === "~") dir = HOME;

    // Validate directory
    try {
        const stat = (await import("fs")).statSync(dir);
        if (!stat.isDirectory()) {
            await ctx.reply(`Not a directory: ${dir}`);
            return;
        }
    } catch {
        await ctx.reply(`Directory not found: ${dir}`);
        return;
    }

    // Kill any running process
    killProcess();

    // Spawn a new Claude session to get a session ID
    const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model", "claude-sonnet-4-6",
    ];

    console.log(`Creating new session in ${dir}`);
    const child = Bun.spawn([CLAUDE_BIN, ...args], {
        cwd: dir,
        env: makeClaudeEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    // Read init event to get session ID
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sessionId: string | null = null;

    const timeout = setTimeout(() => {
        if (!sessionId) {
            child.kill();
            ctx.reply("Timeout waiting for Claude to start.").catch(() => {});
        }
    }, 30000);

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
                    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
                        sessionId = ev.session_id;
                        break;
                    }
                } catch {}
            }
            if (sessionId) break;
        }
    } catch {}

    clearTimeout(timeout);

    // Kill the process — we just needed the session ID
    try { child.kill(); } catch {}

    if (!sessionId) {
        await ctx.reply("Failed to create session.");
        return;
    }

    // Derive name from directory
    const name = dir.split("/").filter(Boolean).pop() || "unnamed";

    cfg.sessions[sessionId] = {
        name,
        directory: dir,
        last_messages: [],
    };
    cfg.active_session = sessionId;
    saveConfig();

    await ctx.reply(
        `Session created: <b>${escapeHtml(name)}</b>\nDirectory: <code>${escapeHtml(dir)}</code>\nSession: <code>${sessionId.slice(0, 12)}...</code>\n\nSend a message to start.`,
        { parse_mode: "HTML" },
    );
});

// Voice messages
bot.on("message:voice", async (ctx) => {
    if (!cfg.active_session) {
        await ctx.reply("No active session. Use /resume to pick one.");
        return;
    }
    if (responding) {
        await ctx.reply("Agent is still responding. Please wait.");
        return;
    }

    const sessionId = cfg.active_session;

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

        // Re-check active session (might have changed during transcription)
        if (cfg.active_session !== sessionId) {
            await ctx.reply("Session changed during transcription. Message not sent.");
            return;
        }

        await sendToAgent(sessionId, transcription, ctx.chat.id, bot);
    } catch (err) {
        console.error("Voice error:", err);
        await ctx.reply(`Voice error: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// Text messages
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    if (!cfg.active_session) {
        await ctx.reply("No active session. Use /resume to pick one.");
        return;
    }
    if (responding) {
        await ctx.reply("Agent is still responding. Please wait.");
        return;
    }

    await sendToAgent(cfg.active_session, text, ctx.chat.id, bot);
});

bot.catch((err) => console.error("Bot error:", err));
bot.start();
console.log("Telegram ACP bot started (single-user mode)");
