import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PurchasedSong = {
  position: number;
  key: string;
  title: string;
  artist: string;
  album: string;
  duration?: string;
};

export type PurchasedSongSnapshot = {
  capturedAt: string;
  count: number;
  songs: PurchasedSong[];
};

export function mergeVisibleRows(existing: PurchasedSong[], visible: Omit<PurchasedSong, 'position'>[]): PurchasedSong[] {
  const byKey = new Set(existing.map((song) => song.key));
  const merged = existing.slice();
  for (const row of visible) {
    if (!row.key || byKey.has(row.key)) continue;
    byKey.add(row.key);
    merged.push({ ...row, position: merged.length });
  }
  return merged;
}

export function snapshotSongs(songs: PurchasedSong[], capturedAt = new Date().toISOString()): PurchasedSongSnapshot {
  return { capturedAt, count: songs.length, songs: songs.map((song, position) => ({ ...song, position })) };
}

export function writePurchasedSongSnapshot(snapshot: PurchasedSongSnapshot, jsonPath: string, csvPath: string): void {
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  writeFileSync(csvPath, toPurchasedSongsCsv(snapshot.songs), 'utf8');
}

export function toPurchasedSongsCsv(songs: PurchasedSong[]): string {
  const header = ['position', 'key', 'title', 'artist', 'album', 'duration'];
  const lines = [header.join(',')];
  for (const song of songs) {
    lines.push([song.position, song.key, song.title, song.artist, song.album, song.duration ?? ''].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
