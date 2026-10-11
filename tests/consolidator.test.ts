import AdmZip from 'adm-zip';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { consolidateLibrary, coreTitle, extractArchives } from '../src/consolidator.js';

test('extracts zips and consolidates distinct Artist/Album/filename recordings', () => {
  const root = mkTemp();
  const downloads = join(root, 'downloads');
  const extracted = join(downloads, 'extracted');
  const out = join(root, 'Purchased');
  mkdirSync(downloads, { recursive: true });

  writeZip(join(downloads, 'win_0_139.zip'), {
    'Artist/Album/01 - Same.mp3': 'a',
    'Artist/Album/02 - Instrumental.mp3': 'b',
  });
  writeZip(join(downloads, 'win_90_229.zip'), {
    'Artist/Album/01 - Same.mp3': 'a again',
    'Artist/Other Album/01 - Same.mp3': 'different album',
  });

  assert.equal(extractArchives(downloads, extracted), 2);
  const result = consolidateLibrary({ extractedDir: extracted, unsortedDir: join(root, 'Unsorted'), outputDir: out });

  assert.equal(result.fromZips, 3);
  assert.ok(existsSync(join(out, 'Artist', 'Album', '01 - Same.mp3')));
  assert.ok(existsSync(join(out, 'Artist', 'Album', '02 - Instrumental.mp3')));
  assert.ok(existsSync(join(out, 'Artist', 'Other Album', '01 - Same.mp3')));
});

test('fills missing zip recordings from flat Unsorted files using purchased metadata', () => {
  const root = mkTemp();
  const extracted = join(root, 'extracted');
  const unsorted = join(root, 'Unsorted');
  const out = join(root, 'Purchased');
  mkdirSync(join(extracted, 'win_0_139', 'Various Artists', 'The Beatles Tribute'), { recursive: true });
  writeFileSync(join(extracted, 'win_0_139', 'Various Artists', 'The Beatles Tribute', '01 - The Long And Winding Road.mp3'), 'audio');
  mkdirSync(unsorted, { recursive: true });
  writeFileSync(join(unsorted, '09 - Eleanor Rigby.mp3'), 'audio');

  const result = consolidateLibrary({
    extractedDir: extracted,
    unsortedDir: unsorted,
    outputDir: out,
    purchasedSongs: [{ title: 'Eleanor Rigby', artist: 'Various artists', album: 'The Beatles Tribute: An All-Star Jazz Celebration' }],
  });

  assert.equal(result.addedFromUnsorted, 1);
  assert.ok(existsSync(join(out, 'Various artists', 'The Beatles Tribute  An All-Star Jazz Celebration', '09 - Eleanor Rigby.mp3')));
});

test('consolidation is idempotent on rerun', () => {
  const root = mkTemp();
  const extracted = join(root, 'extracted');
  const out = join(root, 'Purchased');
  mkdirSync(join(extracted, 'win_0_139', 'Artist', 'Album'), { recursive: true });
  writeFileSync(join(extracted, 'win_0_139', 'Artist', 'Album', '01 - Same.mp3'), 'audio');

  const first = consolidateLibrary({ extractedDir: extracted, unsortedDir: join(root, 'Unsorted'), outputDir: out });
  const second = consolidateLibrary({ extractedDir: extracted, unsortedDir: join(root, 'Unsorted'), outputDir: out });

  assert.equal(first.total, 1);
  assert.equal(second.fromZips, 0);
  assert.equal(second.total, 1);
});

test('flat Unsorted fill is not suppressed by same title in a different zip album', () => {
  const root = mkTemp();
  const extracted = join(root, 'extracted');
  const unsorted = join(root, 'Unsorted');
  const out = join(root, 'Purchased');
  mkdirSync(join(extracted, 'win_0_139', 'Artist A', 'Album A'), { recursive: true });
  writeFileSync(join(extracted, 'win_0_139', 'Artist A', 'Album A', '01 - Intro.mp3'), 'zip-audio');
  mkdirSync(unsorted, { recursive: true });
  writeFileSync(join(unsorted, '01 - Intro.mp3'), 'flat-audio');

  const result = consolidateLibrary({
    extractedDir: extracted,
    unsortedDir: unsorted,
    outputDir: out,
    purchasedSongs: [{ title: 'Intro', artist: 'Artist B', album: 'Album B' }],
  });

  assert.equal(result.addedFromUnsorted, 1);
  assert.ok(existsSync(join(out, 'Artist A', 'Album A', '01 - Intro.mp3')));
  assert.ok(existsSync(join(out, 'Artist B', 'Album B', '01 - Intro.mp3')));
});

test('reports unmatched flat Unsorted files without copying them into Purchased', () => {
  const root = mkTemp();
  const extracted = join(root, 'extracted');
  const unsorted = join(root, 'Unsorted');
  const out = join(root, 'Purchased');
  mkdirSync(unsorted, { recursive: true });
  writeFileSync(join(unsorted, 'Mystery.mp3'), 'audio');

  const result = consolidateLibrary({ extractedDir: extracted, unsortedDir: unsorted, outputDir: out, purchasedSongs: [] });

  assert.deepEqual(result.unmatched, ['Mystery.mp3']);
  assert.equal(result.addedFromUnsorted, 0);
  assert.equal(result.total, 0);
});

test('coreTitle keeps meaningful version words while ignoring duplicate suffixes', () => {
  assert.equal(coreTitle('05 - I Am A Man Of Constant Sorrow (Radio Edit) [Explicit].mp3'), 'i am a man of constant sorrow radio edit');
  assert.equal(coreTitle('05 - I Am A Man Of Constant Sorrow (Radio Edit) (2).mp3'), 'i am a man of constant sorrow radio edit');
});

function writeZip(path: string, entries: Record<string, string>): void {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  zip.writeZip(path);
}

function mkTemp(): string {
  return join(tmpdir(), `amz-music-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
