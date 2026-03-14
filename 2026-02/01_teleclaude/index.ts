import { Bot, InlineKeyboard, InputFile } from "grammy";
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import yaml from "js-yaml";
import sharp from "sharp";

// --- Config ---

interface GroupConfig {
    directory: string;
    session_id?: string;
}

interface Config {
    token: string;
    gemini_api_key: string;
    gemini_model?: string;
    allowed_users: number[];
    groups: Record<string, GroupConfig>;
}

const configIdx = process.argv.indexOf("--config");
const CONFIG_PATH: string =
    configIdx !== -1 && process.argv[configIdx + 1]
        ? process.argv[configIdx + 1]!
        : "config.yaml";
const cfg = yaml.load(await Bun.file(CONFIG_PATH).text()) as Config;
cfg.gemini_model = cfg.gemini_model || "gemini-3.1-pro-preview";
cfg.groups = cfg.groups || {};

if (!cfg.token) {
    console.error("No 'token' found in config.");
    process.exit(1);
}

function saveConfig() {
    Bun.write(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
}

const HOME = process.env.HOME || "/root";

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

// --- Markdown rendering pipeline ---

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeSvg(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function textToTelegramHtml(md: string): string {
    let out = md;
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

// --- Segment parser: splits markdown into text, code, table segments ---

type Segment =
    | { type: "text"; content: string }
    | { type: "code"; content: string; lang: string }
    | { type: "table"; content: string };

function parseSegments(md: string): Segment[] {
    const segments: Segment[] = [];
    let remaining = md;

    while (remaining.length > 0) {
        // Find next code fence
        const codeMatch = remaining.match(/^([\s\S]*?)```(\w*)\n([\s\S]*?)```/);
        if (codeMatch) {
            const before = codeMatch[1]!;
            if (before.trim()) pushTextOrTable(segments, before);
            const code = codeMatch[3]!;
            const lines = code.split("\n").slice(0, 100);
            segments.push({ type: "code", content: lines.join("\n"), lang: codeMatch[2] || "" });
            remaining = remaining.slice(codeMatch[0]!.length);
            continue;
        }
        // No more code fences — process rest as text/table
        pushTextOrTable(segments, remaining);
        break;
    }
    return segments;
}

function pushTextOrTable(segments: Segment[], text: string) {
    const lines = text.split("\n");
    let buf: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Detect table: line starts with | and contains at least 2 |
        if (line.trimStart().startsWith("|") && (line.match(/\|/g) || []).length >= 2) {
            // Flush text buffer
            if (buf.length > 0) {
                const t = buf.join("\n").trim();
                if (t) segments.push({ type: "text", content: t });
                buf = [];
            }
            // Collect all table lines
            const tableLines: string[] = [line];
            while (i + 1 < lines.length) {
                const next = lines[i + 1]!;
                if (next.trimStart().startsWith("|") && (next.match(/\|/g) || []).length >= 2) {
                    tableLines.push(next);
                    i++;
                } else {
                    break;
                }
            }
            segments.push({ type: "table", content: tableLines.join("\n") });
        } else {
            buf.push(line);
        }
    }
    if (buf.length > 0) {
        const t = buf.join("\n").trim();
        if (t) segments.push({ type: "text", content: t });
    }
}

// --- SVG image rendering ---
// Note: sharp uses librsvg which does NOT support @font-face base64 embedding.
// We must use system font names. Requires: apt install fonts-dejavu-core

const FONT = "DejaVu Sans Mono";
const CHAR_W = 8.8;
const LINE_H = 22;
const PAD = 16;

async function renderCodeImage(code: string, lang: string): Promise<Buffer> {
    const lines = code.split("\n");
    const lineNumW = String(lines.length).length * CHAR_W + 16;
    const maxLen = Math.max(...lines.map(l => l.length), 10);
    const width = Math.ceil(lineNumW + maxLen * CHAR_W + PAD * 2);
    const height = Math.ceil(lines.length * LINE_H + PAD * 2);

    let textEls = "";
    for (let i = 0; i < lines.length; i++) {
        const y = PAD + (i + 1) * LINE_H - 5;
        // Line number
        textEls += `<text x="${PAD}" y="${y}" fill="#858585" font-family="${FONT}" font-size="14">${i + 1}</text>`;
        // Code line
        textEls += `<text x="${lineNumW + PAD}" y="${y}" fill="#d4d4d4" font-family="${FONT}" font-size="14" xml:space="preserve">${escapeSvg(lines[i]!)}</text>`;
    }

    // Language label
    let labelEl = "";
    if (lang) {
        labelEl = `<text x="${width - PAD}" y="${PAD + 12}" fill="#858585" font-family="${FONT}" font-size="12" text-anchor="end">${escapeSvg(lang)}</text>`;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="${width}" height="${height}" rx="8" fill="#1e1e1e"/>
        ${labelEl}
        ${textEls}
    </svg>`;

    return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderTableImage(tableStr: string): Promise<Buffer> {
    const rows = tableStr.split("\n")
        .map(r => r.trim())
        .filter(r => r.startsWith("|"))
        .map(r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));

    // Remove separator row (----)
    const dataRows = rows.filter(r => !r.every(c => /^[-:]+$/.test(c)));
    if (dataRows.length === 0) return Buffer.alloc(0);

    const numCols = Math.max(...dataRows.map(r => r.length));

    // Measure column widths
    const colWidths: number[] = [];
    for (let c = 0; c < numCols; c++) {
        const maxLen = Math.max(...dataRows.map(r => (r[c] || "").length), 3);
        colWidths.push(maxLen * CHAR_W + PAD * 2);
    }

    const rowH = LINE_H + 10;
    const totalW = Math.ceil(colWidths.reduce((a, b) => a + b, 0));
    const totalH = Math.ceil(dataRows.length * rowH + 2);

    let els = "";
    // Background
    els += `<rect width="${totalW}" height="${totalH}" rx="4" fill="#ffffff"/>`;

    // Header background
    els += `<rect width="${totalW}" height="${rowH}" rx="4" fill="#f0f0f0"/>`;

    // Grid lines & text
    for (let ri = 0; ri < dataRows.length; ri++) {
        const row = dataRows[ri]!;
        const y = ri * rowH;

        // Horizontal line
        if (ri > 0) {
            els += `<line x1="0" y1="${y}" x2="${totalW}" y2="${y}" stroke="#ddd" stroke-width="1"/>`;
        }

        let x = 0;
        for (let ci = 0; ci < numCols; ci++) {
            const cell = row[ci] || "";
            const w = colWidths[ci]!;

            // Vertical line
            if (ci > 0) {
                els += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + rowH}" stroke="#ddd" stroke-width="1"/>`;
            }

            // Text
            const fontWeight = ri === 0 ? "bold" : "normal";
            els += `<text x="${x + PAD}" y="${y + rowH / 2 + 5}" fill="#333" font-family="${FONT}" font-size="14" font-weight="${fontWeight}">${escapeSvg(cell)}</text>`;
            x += w;
        }
    }

    // Border
    els += `<rect width="${totalW}" height="${totalH}" rx="4" fill="none" stroke="#ddd" stroke-width="1"/>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}">
        ${els}
    </svg>`;

    return await sharp(Buffer.from(svg)).png().toBuffer();
}

// --- Message sending ---

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

async function sendHtml(ctx: any, html: string, silent = true) {
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

async function sendPhoto(ctx: any, png: Buffer, silent = true) {
    await ctx.replyWithPhoto(new InputFile(png), {
        disable_notification: silent,
    });
}

// Single entry point for all message rendering
async function sendResponse(ctx: any, markdown: string, silent = true) {
    const segments = parseSegments(markdown);
    for (const seg of segments) {
        switch (seg.type) {
            case "text": {
                const html = textToTelegramHtml(seg.content);
                if (html.trim()) await sendHtml(ctx, html, silent);
                break;
            }
            case "code": {
                try {
                    const png = await renderCodeImage(seg.content, seg.lang);
                    await sendPhoto(ctx, png, silent);
                } catch (err) {
                    console.error("Code render error:", err);
                    const escaped = escapeHtml(seg.content);
                    await sendHtml(ctx, `<pre>${escaped}</pre>`, silent);
                }
                break;
            }
            case "table": {
                try {
                    const png = await renderTableImage(seg.content);
                    if (png.length > 0) {
                        await sendPhoto(ctx, png, silent);
                    }
                } catch (err) {
                    console.error("Table render error:", err);
                    await sendHtml(ctx, `<pre>${escapeHtml(seg.content)}</pre>`, silent);
                }
                break;
            }
        }
    }
}

// --- Per-chat state with long-lived Claude process ---

const CLAUDE_BIN = `${HOME}/.local/bin/claude`;

interface ChatState {
    chatId: number;
    directory: string;
    sessionId: string | undefined;
    history: string[];
    child: ReturnType<typeof Bun.spawn> | null;
    responding: boolean;
    typingInterval: ReturnType<typeof setInterval> | null;
    turnStart: number;
    ctx: any;
}

const chatStates = new Map<number, ChatState>();

function getState(chatId: number): ChatState | null {
    let s = chatStates.get(chatId);
    if (s) return s;

    const groupCfg = cfg.groups[String(chatId)];
    if (!groupCfg) return null;

    s = {
        chatId,
        directory: groupCfg.directory,
        sessionId: groupCfg.session_id,
        history: [],
        child: null,
        responding: false,
        typingInterval: null,
        turnStart: 0,
        ctx: null,
    };
    chatStates.set(chatId, s);
    return s;
}

function makeClaudeEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
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

function tag(chatId: number): string {
    return `[${chatId}]`;
}

// Spawn a long-lived Claude process with streaming input/output
function ensureClaudeProcess(state: ChatState, t: string) {
    if (state.child && state.child.exitCode !== null) {
        console.log(`${t} Claude process exited (code ${state.child.exitCode}), respawning`);
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

    console.log(`${t} spawning Claude in ${state.directory}${state.sessionId ? ` (resume ${state.sessionId.slice(0, 8)}...)` : " (new)"}`);

    const child = Bun.spawn([CLAUDE_BIN, ...args], {
        cwd: state.directory,
        env: makeClaudeEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    state.child = child;

    new Response(child.stderr).text().then((stderr) => {
        if (stderr.trim()) console.error(`${t} stderr: ${stderr.slice(0, 500)}`);
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
                    state.ctx?.reply(`Error: Claude process exited with code ${code}`).catch(() => {});
                }
            }
        }
    });
}

async function readClaudeOutput(
    state: ChatState,
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

                    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
                        state.sessionId = ev.session_id;
                        cfg.groups[String(state.chatId)] = {
                            directory: state.directory,
                            session_id: ev.session_id,
                        };
                        saveConfig();
                        console.log(`${t} session: ${ev.session_id.slice(0, 8)}...`);
                    }

                    if (ev.type === "assistant" && ev.message?.content) {
                        for (const block of ev.message.content) {
                            if (block.type === "text" && block.text?.trim()) {
                                const text = block.text.trim();
                                textMessages.push(text);
                                console.log(`${t} text: ${text.slice(0, 200)}`);
                                if (state.ctx) {
                                    await sendResponse(state.ctx, text);
                                }
                            }
                        }
                    }

                    if (ev.type === "result") {
                        if (ev.session_id) {
                            state.sessionId = ev.session_id;
                            cfg.groups[String(state.chatId)] = {
                                directory: state.directory,
                                session_id: ev.session_id,
                            };
                            saveConfig();
                        }

                        stopTyping(state);
                        state.responding = false;

                        const elapsed = ((Date.now() - state.turnStart) / 1000).toFixed(1);
                        const allText = textMessages.join("\n\n");
                        if (allText) {
                            state.history.push(`Assistant: ${allText.slice(0, 300)}`);
                        } else {
                            state.history.push(`Assistant: [no text]`);
                        }
                        if (state.history.length > 10) state.history.splice(0, state.history.length - 10);

                        console.log(`${t} <- claude (${elapsed}s): ${allText ? allText.slice(0, 200) : "[no text]"}`);
                        if (state.ctx) {
                            await state.ctx.reply(`Done (${elapsed}s)`);
                        }

                        textMessages.length = 0;
                    } else if (ev.type === "rate_limit_event") {
                        if (ev.rate_limit_info?.isUsingOverage && state.ctx) {
                            await state.ctx.reply("⚠️ Using overage capacity", { disable_notification: true }).catch(() => {});
                        }
                    } else if (ev.type === "user") {
                        // User message echo — ignore
                    } else if (ev.type !== "system" && ev.type !== "assistant") {
                        // Unhandled event type — show preview in chat
                        if (state.ctx) {
                            const preview = line.slice(0, 200);
                            await state.ctx.reply(`Unhandled: ${preview}`, { disable_notification: true }).catch(() => {});
                        }
                    }
                } catch {}
            }
        }
    } catch (err) {
        console.error(`${t} stdout read error:`, err);
    }
}

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function sendUserMessage(state: ChatState, content: string | ContentBlock[], ctx: any) {
    const t = tag(state.chatId);
    state.ctx = ctx;

    const textPreview = typeof content === "string"
        ? content.slice(0, 300)
        : content.filter(b => b.type === "text").map(b => (b as any).text).join(" ").slice(0, 300) || "(image)";
    state.history.push(`User: ${textPreview}`);
    if (state.history.length > 10) state.history.splice(0, state.history.length - 10);

    ensureClaudeProcess(state, t);

    if (!state.child) {
        ctx.reply("Error: failed to start Claude process").catch(() => {});
        return;
    }

    const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content },
    }) + "\n";

    console.log(`${t} <- user: ${textPreview.slice(0, 200)}`);

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

// --- Bot ---

const bot = new Bot(cfg.token);

// Log all incoming updates
bot.use((ctx, next) => {
    const msg = ctx.message;
    if (msg) {
        console.log(
            `[update] chat=${ctx.chat?.id} type=${ctx.chat?.type} text=${msg.text?.slice(0, 100) || "[non-text]"}`,
        );
    }
    return next();
});

// Auth: only allowed users
bot.use((ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !cfg.allowed_users.includes(userId)) {
        console.log(`[auth] rejected user ${userId}`);
        return;
    }
    return next();
});

// /new — start fresh conversation (keep directory)
bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    const groupCfg = cfg.groups[String(chatId)];
    if (!groupCfg) {
        await ctx.reply("Not configured. Add this chat ID to config.yaml first.");
        return;
    }

    const existing = chatStates.get(chatId);
    if (existing) killProcess(existing);

    delete groupCfg.session_id;
    saveConfig();
    chatStates.delete(chatId);

    await ctx.reply("New conversation started.");
});

// /resume — list last 10 sessions grouped by folder
bot.command("resume", async (ctx) => {
    const chatId = ctx.chat.id;

    try {
        const sessions = await listSessions();
        if (!sessions || sessions.length === 0) {
            await ctx.reply("No sessions found.");
            return;
        }

        // Take last 10 overall (sessions are usually sorted newest first)
        const recent = sessions.slice(0, 10);

        let text = "<b>Recent sessions:</b>\n\n";
        const keyboard = new InlineKeyboard();
        let idx = 1;

        // Group the 10 recent ones by folder for display
        const recentByFolder = new Map<string, { session: any; idx: number }[]>();
        for (const s of recent) {
            const folder = s.cwd || "unknown";
            if (!recentByFolder.has(folder)) recentByFolder.set(folder, []);
            recentByFolder.get(folder)!.push({ session: s, idx });
            idx++;
        }

        // Store session info for callback
        const sessionMap: { sessionId: string; cwd: string }[] = [{ sessionId: "", cwd: "" }];  // 1-indexed
        idx = 1;
        for (const [folder, items] of recentByFolder) {
            text += `<b>${escapeHtml(folder)}</b>\n`;
            for (const { session: s } of items) {
                const summary = s.summary || s.sessionId.slice(0, 8);
                text += `  ${idx}. ${escapeHtml(String(summary)).slice(0, 60)}\n`;
                sessionMap.push({ sessionId: s.sessionId, cwd: s.cwd || "" });
                idx++;
            }
            text += "\n";
        }

        // Store the session map for this chat temporarily
        pendingResumes.set(chatId, sessionMap);

        // Build button rows (5 per row)
        const total = Math.min(recent.length, 10);
        for (let i = 1; i <= total; i++) {
            keyboard.text(String(i), `resume:${i}`);
            if (i % 5 === 0) keyboard.row();
        }

        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (err: any) {
        console.error("listSessions error:", err);
        await ctx.reply(`Error listing sessions: ${err.message || String(err)}`);
    }
});

// Store pending resume selections: index -> {sessionId, cwd}
const pendingResumes = new Map<number, { sessionId: string; cwd: string }[]>();

// Handle resume button callbacks
bot.callbackQuery(/^resume:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const idx = parseInt(ctx.match![1]!);
    const sessionMap = pendingResumes.get(chatId);

    if (!sessionMap || !sessionMap[idx]) {
        await ctx.answerCallbackQuery({ text: "Session expired. Use /resume again." });
        return;
    }

    const { sessionId, cwd } = sessionMap[idx]!;
    pendingResumes.delete(chatId);

    // Kill existing
    const existing = chatStates.get(chatId);
    if (existing) killProcess(existing);

    // Create or update group config
    cfg.groups[String(chatId)] = { directory: cwd, session_id: sessionId };
    saveConfig();
    chatStates.delete(chatId);

    await ctx.answerCallbackQuery({ text: `Resumed session ${sessionId.slice(0, 8)}...` });
    await ctx.editMessageText(`Resumed session: <code>${sessionId.slice(0, 8)}...</code>\n${escapeHtml(cwd)}`, { parse_mode: "HTML" });

    // Send last 2 messages from the session
    try {
        const messages = await getSessionMessages(sessionId);
        const lastTwo = messages.slice(-2);
        for (const msg of lastTwo) {
            const m = msg.message as any;
            if (!m?.content) continue;
            const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
            for (const block of blocks) {
                if (block.type === "text" && block.text?.trim()) {
                    const prefix = msg.type === "user" ? "You" : "Claude";
                    await sendHtml(ctx, `<b>${prefix}:</b>`);
                    await sendResponse(ctx, block.text.trim().slice(0, 500));
                }
            }
        }
    } catch (err) {
        console.error("Failed to fetch session messages:", err);
    }
});

// /stop — abort current response
bot.command("stop", async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chatStates.get(chatId);
    if (state?.responding) {
        killProcess(state);
        await ctx.reply("Stopped.");
    } else {
        await ctx.reply("Nothing running.");
    }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    const state = getState(chatId);
    if (!state) {
        await ctx.reply("Not configured. Add this chat ID to config.yaml first.");
        return;
    }

    try {
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        const oggData = Buffer.from(await resp.arrayBuffer());

        const voiceStart = Date.now();
        let context = state.history.join("\n");
        if (context.length > 5000) context = context.slice(-5000);
        const transcription = await transcribeVoice(oggData, context);
        const voiceSec = ((Date.now() - voiceStart) / 1000).toFixed(1);
        console.log(`[${chatId}] transcribed (${voiceSec}s): ${transcription.slice(0, 200)}`);

        await ctx.reply(`Voice: ${transcription} (${voiceSec}s)`);
        sendUserMessage(state, transcription, ctx);
    } catch (err: any) {
        console.error(`Voice error:`, err);
        await ctx.reply(`Voice error: ${err.message || String(err)}`);
    }
});

// Photos (with or without captions)
bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const state = getState(chatId);
    if (!state) return;

    try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1]!;
        const file = await ctx.api.getFile(largest.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        const imageData = Buffer.from(await resp.arrayBuffer());

        const ext = file.file_path?.split(".").pop()?.toLowerCase() || "jpg";
        const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";

        const content: ContentBlock[] = [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageData.toString("base64") } },
        ];
        const caption = ctx.message.caption?.trim();
        if (caption) content.push({ type: "text", text: caption });

        sendUserMessage(state, content, ctx);
    } catch (err: any) {
        console.error("Photo error:", err);
        await ctx.reply(`Photo error: ${err.message || String(err)}`);
    }
});

// Document images
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const state = getState(chatId);
    if (!state) return;

    const doc = ctx.message.document;
    const mime = doc.mime_type || "";
    const caption = ctx.message.caption?.trim();

    if (IMAGE_MIME_TYPES.has(mime)) {
        try {
            const file = await ctx.api.getFile(doc.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`;
            const resp = await fetch(fileUrl);
            const imageData = Buffer.from(await resp.arrayBuffer());

            const content: ContentBlock[] = [
                { type: "image", source: { type: "base64", media_type: mime, data: imageData.toString("base64") } },
            ];
            if (caption) content.push({ type: "text", text: caption });
            sendUserMessage(state, content, ctx);
        } catch (err: any) {
            console.error("Document image error:", err);
            await ctx.reply(`Error: ${err.message || String(err)}`);
        }
    } else if (caption) {
        sendUserMessage(state, caption, ctx);
    }
});

// Text messages
bot.on("message:text", (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const chatId = ctx.chat.id;
    const state = getState(chatId);
    if (!state) {
        ctx.reply("Not configured. Add this chat ID to config.yaml first.").catch(() => {});
        return;
    }

    sendUserMessage(state, text, ctx);
});

bot.catch((err) => console.error("Bot error:", err));

await bot.api.setMyCommands([
    { command: "new", description: "Start fresh conversation" },
    { command: "resume", description: "Resume a previous session" },
    { command: "stop", description: "Abort current response" },
]);

bot.start();
console.log("Bot started");
