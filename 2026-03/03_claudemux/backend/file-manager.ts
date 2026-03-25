// File browser utilities for ClaudeMux

import { readdir, stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import randomName from '@scaleway/random-name';
import type { FilePreview } from '../frontend/src/types.ts';

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
}

const PREVIEW_BYTE_CAP = 64 * 1024;
const PREVIEW_LINE_CAP = 1200;

const CODE_LANGUAGE_BY_NAME = new Map<string, string>([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['readme', 'markdown'],
]);

const CODE_LANGUAGE_BY_EXT = new Map<string, string>([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.json', 'json'],
  ['.md', 'markdown'],
  ['.css', 'css'],
  ['.html', 'xml'],
  ['.py', 'python'],
  ['.sh', 'bash'],
  ['.bash', 'bash'],
  ['.zsh', 'bash'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.c', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.h', 'c'],
  ['.hpp', 'cpp'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.toml', 'ini'],
  ['.env', 'bash'],
]);

function detectPreviewLanguage(filePath: string): string | null {
  const base = basename(filePath).toLowerCase();
  const named = CODE_LANGUAGE_BY_NAME.get(base);
  if (named) return named;
  return CODE_LANGUAGE_BY_EXT.get(extname(base)) || 'plaintext';
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export async function listDir(dirPath: string): Promise<FileEntry[]> {
  const names = await readdir(dirPath);
  const entries: FileEntry[] = [];

  for (const name of names) {
    try {
      const s = await stat(join(dirPath, name));
      entries.push({ name, isDir: s.isDirectory(), size: s.size });
    } catch {
      // Skip entries we can't stat (broken symlinks etc)
    }
  }

  // Sort: directories first, then files, alphabetical within each group
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

export async function createDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function previewFile(filePath: string): Promise<FilePreview> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error('Not a file');

  const buf = await readFile(filePath);
  if (isBinaryBuffer(buf)) throw new Error('Binary files cannot be previewed');
  const language = detectPreviewLanguage(filePath);

  const originalText = buf.toString('utf-8');
  const lines = originalText.split('\n');
  const truncatedByLines = lines.length > PREVIEW_LINE_CAP;
  let previewText = truncatedByLines ? lines.slice(0, PREVIEW_LINE_CAP).join('\n') : originalText;
  let truncated = truncatedByLines;

  if (Buffer.byteLength(previewText, 'utf-8') > PREVIEW_BYTE_CAP) {
    previewText = Buffer.from(previewText, 'utf-8').subarray(0, PREVIEW_BYTE_CAP).toString('utf-8');
    truncated = true;
  }

  return {
    path: filePath,
    content: previewText,
    language,
    truncated,
    lineCount: previewText.split('\n').length,
    byteCount: buf.byteLength,
  };
}

export function createSession(dirPath: string): string {
  const suffix = randomName();
  const base = basename(dirPath).replace(/[^a-zA-Z0-9_-]/g, '') || 'root';
  const sessionName = `${base}-${suffix}`;

  spawn('tmux', ['-L', 'claudemux', 'new-session', '-d', '-s', sessionName, '-c', dirPath], {
    stdio: 'ignore',
    detached: true,
  }).unref();

  return sessionName;
}

const UPLOAD_DIR = '/tmp/claudemux-uploads';

export async function uploadFile(name: string, base64Data: string): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  // Sanitize filename
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(UPLOAD_DIR, `${Date.now()}-${safeName}`);
  await writeFile(filePath, Buffer.from(base64Data, 'base64'));
  return filePath;
}

export function getSessionDirs(): string[] {
  try {
    const output = execSync(
      `tmux -L claudemux list-panes -a -F '#{pane_current_path}'`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    if (!output) return [];

    const dirs = [...new Set(output.split('\n').filter(Boolean))];
    dirs.sort();
    return dirs;
  } catch {
    return [];
  }
}
