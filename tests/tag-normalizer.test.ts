import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildId3v23Tag, normalizeTagsFromPath, parseTrackFilename } from '../src/tag-normalizer.js';

test('parses Amazon track filenames', () => {
  assert.deepEqual(parseTrackFilename('04 - 22.mp3'), { track: 4, title: '22' });
  assert.deepEqual(parseTrackFilename('No Track Prefix.mp3'), { title: 'No Track Prefix' });
});

test('builds an ID3v2.3 tag with expected text frames', () => {
  const tag = buildId3v23Tag({ title: 'Go', artist: 'blink-182', album: 'blink-182', albumArtist: 'blink-182', track: 9 });
  assert.equal(tag.subarray(0, 3).toString('latin1'), 'ID3');
  assert.ok(tag.includes(Buffer.from('TIT2')));
  assert.ok(tag.includes(Buffer.from('TPE1')));
  assert.ok(tag.includes(Buffer.from('TRCK')));
});

test('normalizes tags from Artist/Album/NN - Title.mp3 path', () => {
  const root = join(tmpdir(), `amz-tags-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dir = join(root, 'blink-182', 'blink-182 [Explicit]');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '09 - Go [Explicit].mp3');
  writeFileSync(file, Buffer.from('audio-payload'));

  const result = normalizeTagsFromPath(root);

  assert.equal(result.updated, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(readFileSync(file).subarray(0, 3).toString('latin1'), 'ID3');
});
