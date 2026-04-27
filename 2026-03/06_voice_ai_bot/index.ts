import { Bot, Context, webhookCallback } from "grammy";
import { randomBytes } from "crypto";

// --- Config ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://myapp.fly.dev
const WEBHOOK_SECRET = randomBytes(32).toString("hex");
const PORT = parseInt(process.env.PORT || "3000", 10);
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => !isNaN(id));
const INACTIVITY_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_HISTORY = 10;
const TELEGRAM_MAX_LENGTH = 4096;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is required");
  process.exit(1);
}
if (ALLOWED_USER_IDS.length === 0) {
  console.error("ALLOWED_USER_IDS is required (comma-separated user IDs)");
  process.exit(1);
}

console.log(`Starting bot with model: ${GEMINI_MODEL}`);
console.log(`Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);

// --- Types ---
interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64
  };
}

interface GeminiMessage {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface QueueItem {
  ctx: Context;
  parts: GeminiPart[];
}

// --- State ---
const userHistory = new Map<number, GeminiMessage[]>();
const userQueue = new Map<number, QueueItem[]>();
const userProcessing = new Map<number, boolean>();
let lastMessageTime = Date.now();

// --- Inactivity timer ---
const inactivityCheck = setInterval(() => {
  if (Date.now() - lastMessageTime > INACTIVITY_TIMEOUT_MS) {
    console.log("No messages for 3 hours. Exiting.");
    clearInterval(inactivityCheck);
    process.exit(0);
  }
}, 60_000);

// --- Gemini API ---
async function callGemini(
  history: GeminiMessage[],
  userParts: GeminiPart[]
): Promise<string> {
  const contents: GeminiMessage[] = [
    ...history,
    { role: "user", parts: userParts },
  ];

  const body = {
    systemInstruction: {
      parts: [
        {
          text: "You are a helpful assistant. Always respond in the same language the user speaks. Be concise.",
        },
      ],
    },
    contents,
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: "LOW",
      },
    },
    tools: [
      { urlContext: {} },
      { googleSearch: {} },
    ],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error("No candidates in Gemini response");
  }

  // Extract all text parts from the response, skip thinking parts
  const textParts: string[] = [];
  for (const part of candidates[0].content.parts) {
    if (part.text && !part.thought) {
      textParts.push(part.text);
    }
  }

  return textParts.join("") || "(empty response)";
}

// --- File download helper ---
async function downloadFileAsBase64(
  bot: Bot,
  fileId: string
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// --- History management ---
function getHistory(userId: number): GeminiMessage[] {
  if (!userHistory.has(userId)) {
    userHistory.set(userId, []);
  }
  return userHistory.get(userId)!;
}

function addToHistory(
  userId: number,
  role: "user" | "model",
  parts: GeminiPart[]
) {
  const history = getHistory(userId);
  history.push({ role, parts });
  // Keep only last MAX_HISTORY messages (pairs count as 2)
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

// --- Message splitting for Telegram ---
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline before limit
    let splitIdx = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitIdx <= 0) splitIdx = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

// --- Queue processing ---
async function processQueue(userId: number, bot: Bot) {
  if (userProcessing.get(userId)) return;
  userProcessing.set(userId, true);

  const queue = userQueue.get(userId) || [];
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      await item.ctx.api.sendChatAction(item.ctx.chat!.id, "typing");

      const history = getHistory(userId);
      const responseText = await callGemini(history, item.parts);

      // Add user message and model response to history
      addToHistory(userId, "user", item.parts);
      addToHistory(userId, "model", [{ text: responseText }]);

      // Send response - try Markdown, fall back to plain text
      const chunks = splitMessage(responseText);
      for (const chunk of chunks) {
        try {
          await item.ctx.reply(chunk, { parse_mode: "Markdown" });
        } catch {
          try {
            await item.ctx.reply(chunk, { parse_mode: "HTML" });
          } catch {
            await item.ctx.reply(chunk);
          }
        }
      }
    } catch (err) {
      console.error(`Error processing message for user ${userId}:`, err);
      try {
        await item.ctx.reply(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      } catch {}
    }
  }

  userProcessing.set(userId, false);
}

function enqueue(userId: number, ctx: Context, parts: GeminiPart[], bot: Bot) {
  lastMessageTime = Date.now();
  if (!userQueue.has(userId)) {
    userQueue.set(userId, []);
  }
  userQueue.get(userId)!.push({ ctx, parts });
  processQueue(userId, bot);
}

// --- Bot setup ---
const bot = new Bot(TELEGRAM_BOT_TOKEN);

// Auth middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !ALLOWED_USER_IDS.includes(userId)) {
    return; // silently ignore
  }
  await next();
});

// /new command - clear history
bot.command("new", async (ctx) => {
  const userId = ctx.from!.id;
  userHistory.delete(userId);
  userQueue.delete(userId);
  userProcessing.delete(userId);
  await ctx.reply("Conversation cleared.");
});

// Text messages
bot.on("message:text", (ctx) => {
  const userId = ctx.from.id;
  enqueue(userId, ctx, [{ text: ctx.message.text }], bot);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const userId = ctx.from.id;
  try {
    const base64 = await downloadFileAsBase64(bot, ctx.message.voice.file_id);
    const parts: GeminiPart[] = [
      {
        inlineData: {
          mimeType: ctx.message.voice.mime_type || "audio/ogg",
          data: base64,
        },
      },
    ];
    if (ctx.message.caption) {
      parts.push({ text: ctx.message.caption });
    }
    enqueue(userId, ctx, parts, bot);
  } catch (err) {
    console.error("Error downloading voice:", err);
    await ctx.reply("Failed to process voice message.");
  }
});

// Audio messages
bot.on("message:audio", async (ctx) => {
  const userId = ctx.from.id;
  try {
    const base64 = await downloadFileAsBase64(bot, ctx.message.audio.file_id);
    const parts: GeminiPart[] = [
      {
        inlineData: {
          mimeType: ctx.message.audio.mime_type || "audio/mpeg",
          data: base64,
        },
      },
    ];
    if (ctx.message.caption) {
      parts.push({ text: ctx.message.caption });
    }
    enqueue(userId, ctx, parts, bot);
  } catch (err) {
    console.error("Error downloading audio:", err);
    await ctx.reply("Failed to process audio message.");
  }
});

// Photo messages
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from.id;
  try {
    // Get largest photo
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const base64 = await downloadFileAsBase64(bot, largest.file_id);
    const parts: GeminiPart[] = [
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64,
        },
      },
    ];
    if (ctx.message.caption) {
      parts.push({ text: ctx.message.caption });
    } else {
      parts.push({ text: "What's in this image?" });
    }
    enqueue(userId, ctx, parts, bot);
  } catch (err) {
    console.error("Error downloading photo:", err);
    await ctx.reply("Failed to process photo.");
  }
});

// Video messages
bot.on("message:video", async (ctx) => {
  const userId = ctx.from.id;
  try {
    const base64 = await downloadFileAsBase64(bot, ctx.message.video.file_id);
    const parts: GeminiPart[] = [
      {
        inlineData: {
          mimeType: ctx.message.video.mime_type || "video/mp4",
          data: base64,
        },
      },
    ];
    if (ctx.message.caption) {
      parts.push({ text: ctx.message.caption });
    }
    enqueue(userId, ctx, parts, bot);
  } catch (err) {
    console.error("Error downloading video:", err);
    await ctx.reply("Failed to process video.");
  }
});

// --- Start ---
if (WEBHOOK_URL) {
  // Production: webhook mode
  const webhookPath = `/webhook/${WEBHOOK_SECRET}`;
  const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;

  const handleUpdate = webhookCallback(bot, "std/http");

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === webhookPath) {
        lastMessageTime = Date.now();
        return handleUpdate(req);
      }
      // Health check
      if (url.pathname === "/") {
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });

  // Register webhook with Telegram
  await bot.api.setWebhook(fullWebhookUrl, {
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });

  console.log(`Webhook mode on port ${PORT}`);
  console.log(`Webhook registered: ${WEBHOOK_URL}/webhook/***`);
} else {
  // Development: long-polling mode
  // Delete any existing webhook first
  await bot.api.deleteWebhook();
  bot.start({
    onStart: () => console.log("Bot started (long-polling)."),
  });
}
