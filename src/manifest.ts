import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ManifestRow = {
  source: string;
  title?: string;
  artist?: string;
  album?: string;
  status: 'downloaded' | 'extracted' | 'verified' | 'duplicate' | 'failed';
  downloadedAt?: string;
  localPath?: string;
  sha256?: string;
  error?: string;
};

const HEADERS = ['source', 'title', 'artist', 'album', 'status', 'downloadedAt', 'localPath', 'sha256', 'error'] as const;

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export class Manifest {
  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, `${HEADERS.join(',')}\n`, 'utf8');
    }
  }

  append(row: ManifestRow): void {
    const line = HEADERS.map((key) => csvEscape(row[key])).join(',');
    appendFileSync(this.path, `${line}\n`, 'utf8');
  }

  knownHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const cols of this.rows()) {
      const status = cols[4];
      const localPath = cols[6];
      const sha = cols[7];
      // Only treat a prior hash as known if the archived file still exists.
      // This prevents stale manifests from causing fresh downloads to be
      // deleted as "duplicates" after a library folder cleanup.
      if (sha && status === 'verified' && localPath && existsSync(localPath)) hashes.add(sha);
    }
    return hashes;
  }

  knownTrackKeys(): Set<string> {
    const keys = new Set<string>();
    for (const cols of this.rows()) {
      const status = cols[4];
      if (status !== 'verified' && status !== 'duplicate') continue;

      const key = trackKey(cols[1], cols[2], cols[3]);
      if (key) keys.add(key);
    }
    return keys;
  }

  private rows(): string[][] {
    const content = readFileSync(this.path, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).slice(1).map(parseCsvLine);
  }
}

export function trackKey(title?: string, artist?: string, album?: string): string | undefined {
  const parts = [title, artist, album].map((part) => part?.trim().toLowerCase() ?? '');
  if (parts.some((part) => !part)) return undefined;
  return parts.join('\u001f');
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && ch === ',') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}
