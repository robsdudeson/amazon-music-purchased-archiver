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

test('dedupes repeated mp3 downloads with different ID3 tags', () => {
  const root = mkdtempSync(join(tmpdir(), 'amz-music-'));
  const downloads = join(root, 'downloads');
  const staging = join(root, 'staging');
  const library = join(root, 'library');
  const manifest = join(root, 'manifest.csv');
  mkdirSync(downloads, { recursive: true });

  writeFileSync(join(downloads, 'track one.mp3'), fakeMp3('first tag', 'same-audio-payload'), { flag: 'wx' });
  writeFileSync(join(downloads, 'track two.mp3'), fakeMp3('second tag', 'same-audio-payload'), { flag: 'wx' });

  const result = organizeDownloads(downloads, staging, library, manifest);

  assert.equal(result.movedAudioFiles, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(readdirSync(join(library, 'Unsorted')).length, 1);
  assert.equal(readdirSync(downloads).length, 0);
});

test('dedupes against existing library files even when manifest has old full-file hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'amz-music-'));
  const downloads = join(root, 'downloads');
  const staging = join(root, 'staging');
  const library = join(root, 'library');
  const unsorted = join(library, 'Unsorted');
  const manifest = join(root, 'manifest.csv');
  mkdirSync(downloads, { recursive: true });
  mkdirSync(unsorted, { recursive: true });

  writeFileSync(join(unsorted, 'track one.mp3'), fakeMp3('archived tag', 'same-audio-payload'), { flag: 'wx' });
  writeFileSync(join(downloads, 'track one again.mp3'), fakeMp3('fresh tag', 'same-audio-payload'), { flag: 'wx' });

  const result = organizeDownloads(downloads, staging, library, manifest);

  assert.equal(result.movedAudioFiles, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(readdirSync(unsorted).length, 1);
  assert.equal(readdirSync(downloads).length, 0);
});

function fakeMp3(tag: string, audio: string): Buffer {
  const tagBytes = Buffer.from(tag);
  const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, tagBytes.length]);
  return Buffer.concat([header, tagBytes, Buffer.from(audio)]);
}
