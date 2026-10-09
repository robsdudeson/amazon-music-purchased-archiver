import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, copyFileSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Manifest } from './manifest.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac']);

export type OrganizeResult = {
  extractedArchives: number;
  movedAudioFiles: number;
  duplicates: number;
  failures: number;
};

export function organizeDownloads(downloadDir: string, stagingDir: string, libraryDir: string, manifestPath: string): OrganizeResult {
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(libraryDir, { recursive: true });

  const manifest = new Manifest(manifestPath);
  const known = manifest.knownHashes();
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
        moveAudio(full, file, libraryDir, manifest, known, result);
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
      moveAudio(full, basename(full), libraryDir, manifest, known, result);
    } catch (error) {
      result.failures++;
      manifest.append({ source: full, status: 'failed', error: String(error) });
    }
  });

  return result;
}

function moveAudio(full: string, filename: string, libraryDir: string, manifest: Manifest, known: Set<string>, result: OrganizeResult): void {
  const sha256 = hashFile(full);
  if (known.has(sha256)) {
    result.duplicates++;
    manifest.append({ source: full, status: 'duplicate', sha256 });
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
    source: full,
    status: 'verified',
    downloadedAt: new Date().toISOString(),
    localPath: dest,
    sha256,
  });
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
