import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { organizeDownloads } from '../src/organizer.js';

test('moves audio files and records duplicates by hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'amz-music-')); 
  const downloads = join(root, 'downloads');
  const staging = join(root, 'staging');
  const library = join(root, 'library');
  const manifest = join(root, 'manifest.csv');
  mkdirSync(downloads, { recursive: true });

  writeFileSync(join(downloads, 'track one.mp3'), 'same-content', { flag: 'wx' });
  writeFileSync(join(downloads, 'track two.mp3'), 'same-content', { flag: 'wx' });

  const result = organizeDownloads(downloads, staging, library, manifest);

  assert.equal(result.movedAudioFiles, 1);
  assert.equal(result.duplicates, 1);
  assert.ok(existsSync(join(library, 'Unsorted', 'track one.mp3')) || existsSync(join(library, 'Unsorted', 'track two.mp3')));
  assert.equal(readdirSync(downloads).length, 0);
});
