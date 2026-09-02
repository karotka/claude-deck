import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const hiddenFilePath = path.join(config.claudeDir, '.claude-monitor-hidden.json');

let hiddenIds = new Set<string>();

export async function loadHiddenSessions(): Promise<void> {
  try {
    const data = await fsp.readFile(hiddenFilePath, 'utf-8');
    const ids = JSON.parse(data);
    hiddenIds = new Set(Array.isArray(ids) ? ids : []);
  } catch {
    hiddenIds = new Set();
  }
}

async function save(): Promise<void> {
  await fsp.writeFile(hiddenFilePath, JSON.stringify([...hiddenIds]), 'utf-8');
}

export function isHidden(sessionId: string): boolean {
  return hiddenIds.has(sessionId);
}

export async function hideSession(sessionId: string): Promise<void> {
  hiddenIds.add(sessionId);
  await save();
}

export async function unhideSession(sessionId: string): Promise<void> {
  hiddenIds.delete(sessionId);
  await save();
}
