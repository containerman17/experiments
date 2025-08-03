import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs/promises';
import path from 'path';
import { config } from 'dotenv';
import { processWithGemini } from './ai/gemini';
import { PayloadElement, ProcessWithAiFunction } from './ai/types';




config();

const processWithAiFunction: ProcessWithAiFunction = processWithGemini;

const BOT_TOKEN = process.env.BOT_TOKEN!;
const WEBHOOK_URL = process.env.WEBHOOK_URL!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const PORT = Number(process.env.PORT) || 3000;

const bot = new Telegraf(BOT_TOKEN);

const MIN_PHOTO_SIDE = 500;

function getUserDir(userId: number): string {
    return path.join('data', 'history', userId.toString());
}

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

async function saveFile(userId: number, content: Buffer | string, extension: string, from: 'user' | 'bot'): Promise<void> {
    const num = await getNextNumber(userId);
    const filename = `${num}_${from}${extension}`;
    const filepath = path.join(getUserDir(userId), filename);

    await fs.writeFile(filepath, content);
    console.log(`Saved: ${filename}`);
}

async function downloadFile(fileId: string, userId: number, extension: string, from: 'user' | 'bot'): Promise<void> {
    const url = await bot.telegram.getFileLink(fileId);
    const response = await fetch(url.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    await saveFile(userId, buffer, extension, from);
}

async function loadHistory(userId: number): Promise<PayloadElement[]> {
    const dir = getUserDir(userId);
    try {
        const files = (await fs.readdir(dir)).sort();
        const history: PayloadElement[] = [];

        for (const file of files) {
            const [_, from] = file.split('_');
            const role = from.startsWith('bot') ? 'bot' : 'user';
            const filePath = path.join(dir, file);
            const ext = path.extname(file);

            if (ext === '.txt') {
                const content = await fs.readFile(filePath, 'utf-8');
                history.push({ from: role, message: content });
            } else {
                history.push({ from: role, file_path: filePath });
            }
        }
        return history;
    } catch {
        return [];
    }
}

bot.command('new', async (ctx) => {
    const dir = getUserDir(ctx.from.id);
    const isRussian = ctx.from.language_code === 'ru';

    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch { }

    await ctx.reply(isRussian ? 'История очищена!' : 'History cleared!');
});

bot.command('think', async (ctx) => {
    const userId = ctx.from.id;
    const isRussian = ctx.from.language_code === 'ru';

    // Load current history
    const history = await loadHistory(userId);

    if (history.length === 0) {
        await ctx.reply(
            isRussian
                ? "Пока не о чем думать. Сначала отправьте мне сообщение!"
                : "There's nothing to think about yet. Send me a message first!");
        return;
    }

    // Save the appropriate "think harder" message based on user's language
    const thinkMessage = isRussian ? 'Подумай получше' : 'Think harder';
    await saveFile(userId, thinkMessage, '.txt', 'user');

    // Reload history with the new message
    const updatedHistory = await loadHistory(userId);

    const streamCallback = async (text: string, isComplete: boolean) => {
        if (text) {
            await ctx.reply(text);
        }
    };

    const lang = isRussian ? 'ru' : 'en';
    const response = await processWithAiFunction(updatedHistory, 'heavy', streamCallback, lang);
    await saveFile(userId, response, '.txt', 'bot');
});

bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message;
    const isRussian = ctx.from.language_code === 'ru';

    const saveAndProcess = async () => {
        if ('text' in msg && msg.text) {
            await saveFile(userId, msg.text, '.txt', 'user');
        } else if ('caption' in msg && msg.caption) {
            await saveFile(userId, msg.caption, '.txt', 'user');
        }

        if ('photo' in msg && msg.photo) {
            let selectedPhoto = msg.photo.find(p => p.width >= MIN_PHOTO_SIDE || p.height >= MIN_PHOTO_SIDE);
            if (!selectedPhoto) {
                selectedPhoto = msg.photo[msg.photo.length - 1];
            }
            await downloadFile(selectedPhoto.file_id, userId, '.jpg', 'user');
        }

        if ('voice' in msg && msg.voice) {
            await downloadFile(msg.voice.file_id, userId, '.ogg', 'user');
        }

        if ('document' in msg && msg.document) {
            const ext = path.extname(msg.document.file_name || '') || '.file';
            await downloadFile(msg.document.file_id, userId, ext, 'user');
        }

        if ('video' in msg && msg.video) {
            await downloadFile(msg.video.file_id, userId, '.mp4', 'user');
        }

        if ('audio' in msg && msg.audio) {
            const ext = path.extname(msg.audio.file_name || '') || '.mp3';
            await downloadFile(msg.audio.file_id, userId, ext, 'user');
        }

        const history = await loadHistory(userId);

        const streamCallback = async (text: string, isComplete: boolean) => {
            console.log("streamCallback >>>", text);
            if (text) {
                await ctx.reply(text);
            }
        };

        const lang = isRussian ? 'ru' : 'en';
        const response = await processWithAiFunction(history, 'light', streamCallback, lang);
        await saveFile(userId, response, '.txt', 'bot');
    };

    await saveAndProcess();
});

bot.launch({
    webhook: WEBHOOK_URL ? {
        domain: WEBHOOK_URL,
        port: PORT,
        path: `/webhook${WEBHOOK_SECRET}`,
    } : undefined
});

console.log(`Bot running on port ${PORT}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
