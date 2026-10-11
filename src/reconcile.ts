import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PurchasedSong } from './purchased-list.js';

export type ReconcileReport = {
  purchases: number;
  recordings: number;
  warnings: string[];
};

export function reconcilePurchasedLibrary(songs: PurchasedSong[], libraryDir: string): ReconcileReport {
  const recordings = countMp3(libraryDir);
  const warnings: string[] = [];
  if (recordings < songs.length * 0.75) warnings.push(`Recording count ${recordings} is unexpectedly low for ${songs.length} purchase entries.`);
  return { purchases: songs.length, recordings, warnings };
}

export function writeReconcileReport(report: ReconcileReport, path: string): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function countMp3(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) count += countMp3(path);
    else if (stat.isFile() && path.toLowerCase().endsWith('.mp3')) count++;
  }
  return count;
}
