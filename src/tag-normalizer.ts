import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export type TagNormalizationResult = {
  updated: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
};

export function normalizeTagsFromPath(libraryDir: string): TagNormalizationResult {
  const result: TagNormalizationResult = { updated: 0, skipped: 0, errors: [] };
  walk(libraryDir, (path) => {
    if (!path.toLowerCase().endsWith('.mp3')) return;
    const rel = relative(libraryDir, path);
    const parts = rel.split(sep);
    if (parts.length < 3) {
      result.skipped++;
      return;
    }

    const [artist, album] = parts;
    const parsed = parseTrackFilename(basename(path));
    try {
      const original = readFileSync(path);
      const audio = stripExistingId3(original);
      const tag = buildId3v23Tag({
        title: parsed.title,
        artist,
        album,
        albumArtist: artist.toLowerCase() === 'various artists' ? 'Various Artists' : artist,
        track: parsed.track,
      });
      writeFileSync(path, Buffer.concat([tag, audio]));
      result.updated++;
    } catch (error) {
      result.errors.push({ file: rel, error: String(error) });
    }
  });
  return result;
}

export function parseTrackFilename(filename: string): { track?: number; title: string } {
  const match = filename.match(/^\s*(\d{1,3})\s+-\s+(.*)\.mp3$/i);
  if (!match) return { title: filename.replace(/\.mp3$/i, '') };
  return { track: Number(match[1]), title: match[2] };
}

export function buildId3v23Tag(tags: { title: string; artist: string; album: string; albumArtist: string; track?: number }): Buffer {
  const frames = [
    textFrame('TIT2', tags.title),
    textFrame('TPE1', tags.artist),
    textFrame('TALB', tags.album),
    textFrame('TPE2', tags.albumArtist),
  ];
  if (tags.track !== undefined) frames.push(textFrame('TRCK', String(tags.track)));
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncSafe(body.length), body]);
}

function textFrame(id: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]);
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function syncSafe(size: number): Buffer {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

function stripExistingId3(content: Buffer): Buffer {
  let start = 0;
  let end = content.length;
  if (content.subarray(0, 3).toString('latin1') === 'ID3' && content.length >= 10) {
    const size = ((content[6] & 0x7f) << 21) | ((content[7] & 0x7f) << 14) | ((content[8] & 0x7f) << 7) | (content[9] & 0x7f);
    start = 10 + size;
    if ((content[5] & 0x10) === 0x10) start += 10;
  }
  if (end >= 128 && content.subarray(end - 128, end - 125).toString('latin1') === 'TAG') end -= 128;
  return content.subarray(Math.min(start, end), end);
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
