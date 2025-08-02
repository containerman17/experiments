import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs/promises';
import path from 'path';
import { config } from 'dotenv';

config();

const BOT_TOKEN = process.env.BOT_TOKEN!;
const WEBHOOK_URL = process.env.WEBHOOK_URL!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const PORT = Number(process.env.PORT) || 3000;

const bot = new Telegraf(BOT_TOKEN);

// Minimum photo dimension for quality
const MIN_PHOTO_SIDE = 500;

// Get user history directory
function getUserDir(userId: number): string {
    return path.join('data', 'history', userId.toString());
}

// Get next file number
async function getNextNumber(userId: number): Promise<string> {
    const dir = getUserDir(userId);
    await fs.mkdir(dir, { recursive: true });

    const files = await fs.readdir(dir);
    const numbers = files
        .map(f => parseInt(f.split('_')[0]))
        .filter(n => !isNaN(n))
        .sort((a, b) => b - a);

    const next = numbers[0] ? numbers[0] + 1 : 1;
    return next.toString().padStart(3, '0');
}

// Save any file
async function saveFile(userId: number, content: Buffer | string, extension: string, from: 'user' | 'bot'): Promise<void> {
    const num = await getNextNumber(userId);
    const filename = `${num}_${from}${extension}`;
    const filepath = path.join(getUserDir(userId), filename);

    await fs.writeFile(filepath, content);
    console.log(`Saved: ${filename}`);
}

// Download and save telegram file
async function downloadFile(fileId: string, userId: number, extension: string, from: 'user' | 'bot'): Promise<void> {
    const url = await bot.telegram.getFileLink(fileId);
    const response = await fetch(url.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    await saveFile(userId, buffer, extension, from);
}

// Load conversation history
async function loadHistory(userId: number): Promise<string[]> {
    const dir = getUserDir(userId);

    try {
        const files = await fs.readdir(dir);
        return files.sort(); // Files are already numbered
    } catch {
        return [];
    }
}

// Mock AI processing
async function processWithAI(history: string[]): Promise<string> {
    return `Hello! I see ${history.length} messages in our conversation.`;
}

// Clear history command
bot.command(['clear', 'new'], async (ctx) => {
    const dir = getUserDir(ctx.from.id);

    try {
        const files = await fs.readdir(dir);
        await Promise.all(files.map(f => fs.unlink(path.join(dir, f))));
        await fs.rmdir(dir);
    } catch { }

    await ctx.reply('History cleared!');
});

// Handle any message
bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message;

    // Save text if present (including captions)
    if ('text' in msg && msg.text) {
        await saveFile(userId, msg.text, '.txt', 'user');
    } else if ('caption' in msg && msg.caption) {
        await saveFile(userId, msg.caption, '.txt', 'user');
    }

    // Save photo if present (pick best quality)
    if ('photo' in msg && msg.photo) {
        // Find first photo with width or height >= MIN_PHOTO_SIDE
        let selectedPhoto = msg.photo.find(p =>
            p.width >= MIN_PHOTO_SIDE || p.height >= MIN_PHOTO_SIDE
        );

        // If none found, use the largest (last one)
        if (!selectedPhoto) {
            selectedPhoto = msg.photo[msg.photo.length - 1];
        }

        await downloadFile(selectedPhoto.file_id, userId, '.jpg', 'user');
    }

    // Save voice if present
    if ('voice' in msg && msg.voice) {
        await downloadFile(msg.voice.file_id, userId, '.ogg', 'user');
    }

    // Save document if present
    if ('document' in msg && msg.document) {
        const ext = path.extname(msg.document.file_name || '') || '.file';
        await downloadFile(msg.document.file_id, userId, ext, 'user');
    }

    // Save video if present
    if ('video' in msg && msg.video) {
        await downloadFile(msg.video.file_id, userId, '.mp4', 'user');
    }

    // Save audio if present
    if ('audio' in msg && msg.audio) {
        const ext = path.extname(msg.audio.file_name || '') || '.mp3';
        await downloadFile(msg.audio.file_id, userId, ext, 'user');
    }

    // Process and respond
    const history = await loadHistory(userId);
    const response = await processWithAI(history);
    await ctx.reply(response);

    // Save bot response
    await saveFile(userId, response, '.txt', 'bot');
});

// Launch with webhook
bot.launch({
    webhook: {
        domain: WEBHOOK_URL,
        port: PORT,
        path: `/webhook${WEBHOOK_SECRET}`,
    }
});

console.log(`Bot running on port ${PORT}`);

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
