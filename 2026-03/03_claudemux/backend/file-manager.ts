// File browser utilities for ClaudeMux

import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import randomName from '@scaleway/random-name';

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
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
