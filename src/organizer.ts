import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, copyFileSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Manifest, type ManifestRow } from './manifest.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac']);

export type OrganizeResult = {
  extractedArchives: number;
  movedAudioFiles: number;
  duplicates: number;
  failures: number;
};

export type DownloadMetadata = Pick<ManifestRow, 'title' | 'artist' | 'album'>;

export function organizeDownloads(downloadDir: string, stagingDir: string, libraryDir: string, manifestPath: string, metadata: DownloadMetadata = {}): OrganizeResult {
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(libraryDir, { recursive: true });

  const manifest = new Manifest(manifestPath);
  const known = manifest.knownHashes();
  addLibraryAudioHashes(known, join(libraryDir, 'Unsorted'));
  const result: OrganizeResult = { extractedArchives: 0, movedAudioFiles: 0, duplicates: 0, failures: 0 };

  for (const file of readdirSync(downloadDir)) {
    const full = join(downloadDir, file);
    if (!statSync(full).isFile() || file.endsWith('.crdownload') || file.endsWith('.part')) continue;

    try {
      if (extname(file).toLowerCase() === '.zip') {
        const extractTo = join(stagingDir, file.replace(/\.zip$/i, ''));
        mkdirSync(extractTo, { recursive: true });
        new AdmZip(full).extractAllTo(extractTo, true);
        renameSync(full, join(stagingDir, file));
        result.extractedArchives++;
      } else if (AUDIO_EXTENSIONS.has(extname(file).toLowerCase())) {
        moveAudio(full, file, libraryDir, manifest, known, result, metadata);
      }
    } catch (error) {
      result.failures++;
      manifest.append({ source: full, status: 'failed', error: String(error) });
    }
  }

  walk(stagingDir, (full) => {
    const ext = extname(full).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return;
    try {
      moveAudio(full, basename(full), libraryDir, manifest, known, result, metadata);
    } catch (error) {
      result.failures++;
      manifest.append({ source: full, status: 'failed', error: String(error) });
    }
  });

  return result;
}

function moveAudio(full: string, filename: string, libraryDir: string, manifest: Manifest, known: Set<string>, result: OrganizeResult, metadata: DownloadMetadata): void {
  const sha256 = audioContentHash(full);
  if (known.has(sha256)) {
    result.duplicates++;
    manifest.append({ ...metadata, source: full, status: 'duplicate', sha256 });
    rmSync(full, { force: true });
    return;
  }

  const destDir = join(libraryDir, 'Unsorted');
  mkdirSync(destDir, { recursive: true });
  const dest = uniquePath(join(destDir, sanitize(filename)));
  copyFileSync(full, dest);
  rmSync(full, { force: true });
  known.add(sha256);
  result.movedAudioFiles++;
  manifest.append({
    ...metadata,
    source: full,
    status: 'verified',
    downloadedAt: new Date().toISOString(),
    localPath: dest,
    sha256,
  });
}

function addLibraryAudioHashes(known: Set<string>, libraryDir: string): void {
  walk(libraryDir, (full) => {
    if (AUDIO_EXTENSIONS.has(extname(full).toLowerCase())) known.add(audioContentHash(full));
  });
}

function audioContentHash(path: string): string {
  const content = readFileSync(path);
  const [start, end] = audioContentSpan(content);
  return createHash('sha256').update(content.subarray(start, end)).digest('hex');
}

function audioContentSpan(content: Buffer): [number, number] {
  let start = 0;
  let end = content.length;

  // Amazon may return the same MP3 audio with different ID3 metadata on
  // repeated downloads. Hash the MPEG payload, not mutable tags, so those
  // reruns are recognized as duplicates.
  if (content.subarray(0, 3).toString('latin1') === 'ID3' && content.length >= 10) {
    const tagSize = ((content[6] & 0x7f) << 21) | ((content[7] & 0x7f) << 14) | ((content[8] & 0x7f) << 7) | (content[9] & 0x7f);
    start = 10 + tagSize;
    const hasFooter = (content[5] & 0x10) === 0x10;
    if (hasFooter) start += 10;
  }

  if (end >= 128 && content.subarray(end - 128, end - 125).toString('latin1') === 'TAG') {
    end -= 128;
  }

  return [Math.min(start, end), end];
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const base = path.slice(0, -ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'track';
}

function walk(dir: string, fn: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, fn);
    else if (stat.isFile()) fn(full);
  }
}
