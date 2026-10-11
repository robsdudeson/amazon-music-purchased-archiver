import AdmZip from 'adm-zip';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac']);

export type ConsolidateResult = {
  extractedArchives: number;
  fromZips: number;
  addedFromUnsorted: number;
  total: number;
  unmatched: string[];
};

export function extractArchives(downloadDir: string, extractedDir: string): number {
  mkdirSync(extractedDir, { recursive: true });
  let extracted = 0;
  for (const file of readdirSync(downloadDir)) {
    if (extname(file).toLowerCase() !== '.zip') continue;
    const source = join(downloadDir, file);
    if (!statSync(source).isFile()) continue;
    const target = join(extractedDir, file.replace(/\.zip$/i, ''));
    if (existsSync(target)) continue;
    mkdirSync(target, { recursive: true });
    new AdmZip(source).extractAllTo(target, true);
    extracted++;
  }
  return extracted;
}

export function consolidateLibrary(options: {
  extractedDir: string;
  unsortedDir: string;
  outputDir: string;
  purchasedSongs?: Array<{ title: string; artist: string; album?: string }>;
}): ConsolidateResult {
  mkdirSync(options.outputDir, { recursive: true });
  const seenTree = new Set<string>();
  let fromZips = 0;

  walk(options.extractedDir, (path) => {
    if (!isAudio(path)) return;
    const rel = relative(options.extractedDir, path);
    const parts = rel.split(sep);
    const artist = parts.length >= 3 ? parts[1] : '';
    const album = parts.length >= 4 ? parts[2] : '';
    const name = basename(path);
    const treeKey = [normalize(artist), normalize(album), normalize(name)].join('\u001f');
    if (seenTree.has(treeKey)) return;
    seenTree.add(treeKey);
    if (copyToLibrary(path, options.outputDir, artist, album, name)) fromZips++;
  });

  let addedFromUnsorted = 0;
  const unmatched: string[] = [];
  for (const file of existsSync(options.unsortedDir) ? readdirSync(options.unsortedDir) : []) {
    const path = join(options.unsortedDir, file);
    if (!statSync(path).isFile() || !isAudio(path)) continue;
    const match = matchPurchasedSong(file, options.purchasedSongs ?? []);
    if (!match) {
      unmatched.push(file);
      continue;
    }
    if (copyToLibrary(path, options.outputDir, match.artist, match.album ?? '', file)) addedFromUnsorted++;
  }

  return {
    extractedArchives: 0,
    fromZips,
    addedFromUnsorted,
    total: countAudio(options.outputDir),
    unmatched,
  };
}

export function coreTitle(filename: string): string {
  return normalize(filename)
    .replace(/\bmp3\b$/i, '')
    .replace(/\s+\d+$/u, '')
    .replace(/^disc \d+\s+/u, '')
    .replace(/^\d{1,2}\s+/u, '')
    .replace(/\bexplicit\b/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function matchPurchasedSong(filename: string, songs: Array<{ title: string; artist: string; album?: string }>): { artist: string; album?: string } | undefined {
  const fileCore = coreTitle(filename);
  for (const song of songs) {
    if (coreTitle(song.title) === fileCore) return song;
  }

  const fileTokens = significantTokens(fileCore);
  let best: { artist: string; album?: string } | undefined;
  let bestScore = 0;
  for (const song of songs) {
    const score = overlap(fileTokens, significantTokens(coreTitle(song.title)));
    if (score > bestScore) {
      bestScore = score;
      best = song;
    }
  }
  return bestScore > 0 ? best : undefined;
}

function copyToLibrary(source: string, outputDir: string, artist: string, album: string, name: string): boolean {
  const parts = [artist, album].filter(Boolean).map(sanitizePathPart);
  const targetDir = parts.length ? join(outputDir, ...parts) : outputDir;
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, sanitizePathPart(name));
  if (existsSync(target)) return false;
  copyFileSync(source, target);
  return true;
}

function countAudio(dir: string): number {
  let count = 0;
  walk(dir, (path) => { if (isAudio(path)) count++; });
  return count;
}

function isAudio(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

function walk(dir: string, fn: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, fn);
    else if (stat.isFile()) fn(path);
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’']/gu, '').replace(/\.mp3$/iu, '').replace(/\s+\(\d+\)$/u, '').replace(/[^a-z0-9]+/gu, ' ').trim();
}

function significantTokens(text: string): Set<string> {
  return new Set(text.split(/\s+/u).filter((token) => token.length > 2));
}

function overlap(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) if (right.has(token)) score++;
  return score;
}

function sanitizePathPart(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').trim() || 'Unknown';
}

