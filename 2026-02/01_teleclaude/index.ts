import { Bot } from "grammy";
import yaml from "js-yaml";

// --- Config ---

interface TopicConfig {
    name: string;
    directory: string;
    session_id?: string;
}

interface Config {
    token: string;
    gemini_api_key: string;
    gemini_model?: string;
    topics: Record<number, TopicConfig>;
}

const configIdx = process.argv.indexOf("--config");
const CONFIG_PATH: string =
    configIdx !== -1 && process.argv[configIdx + 1]
        ? process.argv[configIdx + 1]!
        : "config.yaml";
const cfg = yaml.load(await Bun.file(CONFIG_PATH).text()) as Config;
cfg.gemini_model = cfg.gemini_model || "gemini-3.1-pro-preview";
cfg.topics = cfg.topics || {};

if (!cfg.token) {
    console.error(
        "No 'token' found in config. Old multi-bot config? Migrate to new schema.",
    );
    process.exit(1);
}

function saveConfig() {
    Bun.write(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
}

const HOME = process.env.HOME || "/root";
const CLAUDE_BIN = `${HOME}/.local/bin/claude`;

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

async function sendResponse(ctx: any, response: string, silent = true) {
    const html = markdownToTelegramHtml(response);
    for (const chunk of splitMessage(html)) {
        try {
            await ctx.reply(chunk, {
                parse_mode: "HTML",
                disable_notification: silent,
            });
        } catch {
            await ctx.reply(chunk, { disable_notification: silent });
        }
    }
}

// --- Per-topic state with long-lived Claude process ---

interface TopicState {
    threadId: number;
    directory: string;
    sessionId: string | undefined;
    history: string[];
    realtime: boolean;
    child: ReturnType<typeof Bun.spawn> | null;
    responding: boolean;
    typingInterval: ReturnType<typeof setInterval> | null;
    turnStart: number;
    ctx: any;
}

const topicStates = new Map<string, TopicState>();

function getState(chatId: number, threadId: number): TopicState | null {
    const key = `${chatId}:${threadId}`;
    let s = topicStates.get(key);
    if (s) return s;

    const topicCfg = cfg.topics[threadId];
    if (!topicCfg) return null;

    s = {
        threadId,
        directory: topicCfg.directory,
        sessionId: topicCfg.session_id,
        history: [],
        realtime: true,
        child: null,
        responding: false,
        typingInterval: null,
        turnStart: 0,
        ctx: null,
    };
    topicStates.set(key, s);
    return s;
}

function getOrCreateState(
    chatId: number,
    threadId: number,
    directory: string,
): TopicState {
    const key = `${chatId}:${threadId}`;
    let s = topicStates.get(key);
    if (s) {
        s.directory = directory;
        return s;
    }
    s = {
        threadId,
        directory,
        sessionId: undefined,
        history: [],
        realtime: true,
        child: null,
        responding: false,
        typingInterval: null,
        turnStart: 0,
        ctx: null,
    };
    topicStates.set(key, s);
    return s;
}

function startTyping(state: TopicState) {
    if (state.typingInterval) return;
    state.ctx?.replyWithChatAction("typing").catch(() => {});
    state.typingInterval = setInterval(() => {
        state.ctx?.replyWithChatAction("typing").catch(() => {});
    }, 4000);
}

function stopTyping(state: TopicState) {
    if (state.typingInterval) {
        clearInterval(state.typingInterval);
        state.typingInterval = null;
    }
}

function killProcess(state: TopicState) {
    stopTyping(state);
    if (state.child) {
        try {
            state.child.kill();
        } catch {}
        state.child = null;
    }
    state.responding = false;
}

function tag(chatId: number, threadId: number): string {
    return `[${chatId}:t${threadId}]`;
}

// Spawn a long-lived Claude process with streaming input/output
function ensureClaudeProcess(state: TopicState, t: string) {
    if (state.child && state.child.exitCode !== null) {
        console.log(
            `${t} Claude process already exited (code ${state.child.exitCode}), respawning`,
        );
        state.child = null;
    }
    if (state.child) return;

    const args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        "claude-opus-4-6",
    ];
    if (state.sessionId) {
        args.push("--resume", state.sessionId);
    }

    console.log(
        `${t} spawning Claude process in ${state.directory}${state.sessionId ? ` (resume ${state.sessionId.slice(0, 8)}...)` : " (new)"}`,
    );

    const child = Bun.spawn([CLAUDE_BIN, ...args], {
        cwd: state.directory,
        env: makeClaudeEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    state.child = child;

    new Response(child.stderr).text().then((stderr) => {
        if (stderr.trim())
            console.error(`${t} stderr: ${stderr.slice(0, 500)}`);
    });

    readClaudeOutput(state, t, child);

    child.exited.then((code) => {
        console.log(`${t} Claude process exited (code ${code})`);
        if (state.child === child) {
            state.child = null;
            if (state.responding) {
                state.responding = false;
                stopTyping(state);
                if (code !== 0) {
                    state.ctx
                        ?.reply(
                            `Error: Claude process exited with code ${code}`,
                        )
                        .catch(() => {});
                }
            }
        }
    });
}

async function readClaudeOutput(
    state: TopicState,
    t: string,
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
                    console.log(`${t} ev: ${line.slice(0, 500)}`);

                    if (
                        ev.type === "system" &&
                        ev.subtype === "init" &&
                        ev.session_id
                    ) {
                        state.sessionId = ev.session_id;
                        if (cfg.topics[state.threadId]) {
                            cfg.topics[state.threadId]!.session_id =
                                ev.session_id;
                            saveConfig();
                        }
                        console.log(
                            `${t} session: ${ev.session_id.slice(0, 8)}...`,
                        );
                    }

                    if (ev.type === "assistant" && ev.message?.content) {
                        for (const block of ev.message.content) {
                            if (block.type === "text" && block.text?.trim()) {
                                const text = block.text.trim();
                                textMessages.push(text);
                                console.log(`${t} text: ${text.slice(0, 200)}`);

                                if (state.realtime && state.ctx) {
                                    await sendResponse(state.ctx, text);
                                }
                            }
                        }
                    }

                    if (ev.type === "result") {
                        if (ev.session_id && cfg.topics[state.threadId]) {
                            state.sessionId = ev.session_id;
                            cfg.topics[state.threadId]!.session_id =
                                ev.session_id;
                            saveConfig();
                        }

                        stopTyping(state);
                        state.responding = false;

                        if (!state.realtime && state.ctx) {
                            for (const text of textMessages) {
                                await sendResponse(state.ctx, text);
                                await Bun.sleep(100);
                            }
                        }

                        const elapsed = (
                            (Date.now() - state.turnStart) /
                            1000
                        ).toFixed(1);
                        const allText = textMessages.join("\n\n");
                        if (allText) {
                            state.history.push(
                                `Assistant: ${allText.slice(0, 300)}`,
                            );
                        } else {
                            state.history.push(`Assistant: [no text]`);
                        }
                        if (state.history.length > 10)
                            state.history.splice(0, state.history.length - 10);

                        console.log(
                            `${t} <- claude (${elapsed}s): ${allText ? allText.slice(0, 200) : "[no text]"}`,
                        );
                        if (state.ctx) {
                            let doneMsg = `Done (${elapsed}s)`;
                            // ev.usage is per-turn; ev.modelUsage is cumulative
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
                                    const pct = (
                                        (used / window) *
                                        100
                                    ).toFixed(1);
                                    const usedK = (used / 1000).toFixed(1);
                                    const windowK = (window / 1000).toFixed(0);
                                    doneMsg += ` | context: ${usedK}k/${windowK}k (${pct}%)`;
                                }
                            }
                            await state.ctx.reply(doneMsg);
                        }

                        textMessages.length = 0;
                    }
                } catch {}
            }
        }
    } catch (err) {
        console.error(`${t} stdout read error:`, err);
    }
}

function sendUserMessage(state: TopicState, text: string, ctx: any) {
    const t = tag(ctx.chat.id, state.threadId);
    state.ctx = ctx;

    state.history.push(`User: ${text.slice(0, 300)}`);
    if (state.history.length > 10)
        state.history.splice(0, state.history.length - 10);

    ensureClaudeProcess(state, t);

    if (!state.child) {
        ctx.reply("Error: failed to start Claude process").catch(() => {});
        return;
    }

    const msg =
        JSON.stringify({
            type: "user",
            message: { role: "user", content: text },
        }) + "\n";

    console.log(`${t} <- user: ${text.slice(0, 200)}`);

    try {
        state.child.stdin.write(msg);
        state.child.stdin.flush();
    } catch (err) {
        console.error(`${t} stdin write error:`, err);
        killProcess(state);
        console.log(`${t} retrying with fresh process`);
        ensureClaudeProcess(state, t);
        if (!state.child) {
            ctx.reply("Error: failed to start Claude process").catch(() => {});
            return;
        }
        try {
            state.child.stdin.write(msg);
            state.child.stdin.flush();
        } catch (err2) {
            console.error(`${t} stdin write error on retry:`, err2);
            killProcess(state);
            ctx.reply("Error: failed to send message to Claude").catch(
                () => {},
            );
            return;
        }
    }

    state.responding = true;
    state.turnStart = Date.now();
    startTyping(state);
}

// --- Helpers ---

function getThreadId(ctx: any): number {
    return ctx.message?.message_thread_id || 1;
}

function isForum(ctx: any): boolean {
    return ctx.chat?.is_forum === true;
}

// --- Cleanup on exit ---

function killAllProcesses() {
    for (const state of topicStates.values()) {
        if (state.child) {
            try {
                state.child.kill();
            } catch {}
        }
    }
}

process.on("SIGINT", () => {
    killAllProcesses();
    process.exit(0);
});
process.on("SIGTERM", () => {
    killAllProcesses();
    process.exit(0);
});
process.on("exit", killAllProcesses);

// --- Bot ---

const bot = new Bot(cfg.token);

// Log all incoming updates
bot.use((ctx, next) => {
    const msg = ctx.message;
    if (msg) {
        console.log(
            `[update] chat=${ctx.chat?.id} type=${ctx.chat?.type} is_forum=${(ctx.chat as any)?.is_forum} thread=${msg.message_thread_id} is_topic=${(msg as any).is_topic_message} text=${msg.text?.slice(0, 100) || "[non-text]"}`,
        );
    } else {
        console.log(
            `[update] non-message update: ${JSON.stringify(ctx.update).slice(0, 300)}`,
        );
    }
    return next();
});

// Forum-only gate
bot.use((ctx, next) => {
    if (!ctx.chat || ctx.chat.type === "channel") return;
    if (!isForum(ctx)) {
        console.log(
            `[gate] rejected: chat=${ctx.chat.id} type=${ctx.chat.type} is_forum=${(ctx.chat as any)?.is_forum}`,
        );
        ctx.reply(
            "This bot only works in forum-enabled supergroups. Enable Topics in your group settings.",
        ).catch(() => {});
        return;
    }
    return next();
});

// /new <directory> — register or re-register a topic
bot.command("new", async (ctx) => {
    const threadId = getThreadId(ctx);
    let dir = ctx.match?.trim() || "";

    // Expand ~
    if (dir.startsWith("~/")) dir = HOME + dir.slice(1);
    else if (dir === "~") dir = HOME;

    const existingCfg = cfg.topics[threadId];

    if (!dir) {
        // No directory arg: reset session if topic already configured, else require it
        if (!existingCfg) {
            ctx.reply(
                "Usage: /new <directory>\nExample: /new /home/user/my-project",
            );
            return;
        }
        dir = existingCfg.directory;
    } else {
        // Validate directory exists
        try {
            const stat = (await import("fs")).statSync(dir);
            if (!stat.isDirectory()) {
                ctx.reply(`Not a directory: ${dir}`);
                return;
            }
        } catch {
            ctx.reply(`Directory not found: ${dir}`);
            return;
        }
    }

    // Kill existing process if any
    const existing = topicStates.get(`${ctx.chat.id}:${threadId}`);
    if (existing) killProcess(existing);

    // Register/update topic
    const topicName =
        existingCfg?.name ||
        (ctx.message as any)?.reply_to_message?.forum_topic_created?.name ||
        `topic-${threadId}`;
    cfg.topics[threadId] = { name: topicName, directory: dir };
    saveConfig();

    const state = getOrCreateState(ctx.chat.id, threadId, dir);
    state.sessionId = undefined;
    state.history = [];

    ctx.reply(
        `Claude Code instance configured.\nDirectory: ${dir}\nSend a message to start.`,
    );
});

// /cd <directory> — change directory for current topic
bot.command("cd", async (ctx) => {
    const threadId = getThreadId(ctx);
    let dir = ctx.match?.trim();
    if (!dir) {
        ctx.reply("Usage: /cd <directory>");
        return;
    }

    if (dir.startsWith("~/")) dir = HOME + dir.slice(1);
    else if (dir === "~") dir = HOME;

    try {
        const stat = await import("fs").then((fs) => fs.statSync(dir));
        if (!stat.isDirectory()) {
            ctx.reply(`Not a directory: ${dir}`);
            return;
        }
    } catch {
        ctx.reply(`Directory not found: ${dir}`);
        return;
    }

    const existing = topicStates.get(`${ctx.chat.id}:${threadId}`);
    if (existing) killProcess(existing);

    if (!cfg.topics[threadId]) {
        cfg.topics[threadId] = { name: `topic-${threadId}`, directory: dir };
    } else {
        cfg.topics[threadId]!.directory = dir;
        cfg.topics[threadId]!.session_id = undefined;
    }
    saveConfig();

    const state = getOrCreateState(ctx.chat.id, threadId, dir);
    state.sessionId = undefined;
    state.history = [];

    ctx.reply(`Directory changed to: ${dir}`);
});

// /realtime — toggle realtime mode
bot.command("realtime", (ctx) => {
    const threadId = getThreadId(ctx);
    const state = getState(ctx.chat.id, threadId);
    if (!state) {
        ctx.reply(
            "No Claude Code instance configured for this topic. Use /new <directory> to set one up.",
        );
        return;
    }
    state.realtime = !state.realtime;
    ctx.reply(`Realtime mode: ${state.realtime ? "on" : "off"}`);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
    const threadId = getThreadId(ctx);
    const state = getState(ctx.chat.id, threadId);
    if (!state) {
        ctx.reply(
            "No Claude Code instance configured for this topic. Use /new <directory> to set one up.",
        );
        return;
    }

    try {
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        const oggData = Buffer.from(await resp.arrayBuffer());

        const t = tag(ctx.chat.id, threadId);
        const voiceStart = Date.now();
        console.log(`${t} <- user: [voice message]`);
        let context = state.history.join("\n");
        if (context.length > 5000) context = context.slice(-5000);
        const transcription = await transcribeVoice(oggData, context);
        const voiceSec = ((Date.now() - voiceStart) / 1000).toFixed(1);
        console.log(
            `${t} transcribed (${voiceSec}s): ${transcription.slice(0, 200)}`,
        );

        await ctx.reply(`🎤 ${transcription} (${voiceSec}s)`);
        sendUserMessage(state, transcription, ctx);
    } catch (err) {
        console.error(`Voice error:`, err);
        await ctx.reply(
            `Voice error: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
});

// Text messages
bot.on("message:text", (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const threadId = getThreadId(ctx);
    const state = getState(ctx.chat.id, threadId);
    if (!state) {
        ctx.reply(
            "No Claude Code instance configured for this topic. Use /new <directory> to set one up.",
        );
        return;
    }

    sendUserMessage(state, text, ctx);
});

bot.catch((err) => console.error("Bot error:", err));
bot.start();
console.log("Bot started (forum mode)");
