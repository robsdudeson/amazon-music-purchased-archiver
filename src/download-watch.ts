import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type DownloadSnapshot = Map<string, number>;

export type ZipWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  stablePolls?: number;
};

export function downloadSnapshot(downloadDir: string): DownloadSnapshot {
  mkdirSync(downloadDir, { recursive: true });
  const snapshot = new Map<string, number>();
  for (const entry of readdirSync(downloadDir, { withFileTypes: true })) {
    if (entry.isFile()) snapshot.set(entry.name, statSync(join(downloadDir, entry.name)).size);
  }
  return snapshot;
}

export async function waitForStableNewZip(downloadDir: string, before: DownloadSnapshot, options: ZipWaitOptions = {}): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 4 * 60_000;
  const pollMs = options.pollMs ?? 4_000;
  const stablePolls = options.stablePolls ?? 3;
  const started = Date.now();
  let lastSize = -1;
  let stable = 0;

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const current = downloadSnapshot(downloadDir);
    const newFiles = Array.from(current.keys()).filter((name) => !before.has(name));
    const partial = newFiles.some(isPartialDownload);
    const zip = newFiles.find((name) => name.toLowerCase().endsWith('.zip'));
    if (!zip || partial) {
      stable = 0;
      continue;
    }

    const size = current.get(zip) ?? 0;
    stable = size === lastSize ? stable + 1 : 0;
    lastSize = size;
    if (stable >= stablePolls) return zip;
  }

  return undefined;
}

export function renameDownloadedZip(downloadDir: string, zipName: string, targetBaseName: string): string {
  const source = join(downloadDir, zipName);
  const targetName = targetBaseName.toLowerCase().endsWith('.zip') ? targetBaseName : `${targetBaseName}.zip`;
  const target = uniquePath(join(downloadDir, targetName));
  renameSync(source, target);
  return target;
}

export function isPartialDownload(name: string): boolean {
  return /\.(crdownload|part|tmp)$/i.test(name);
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dot = path.lastIndexOf('.');
  const base = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? '' : path.slice(dot);
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
