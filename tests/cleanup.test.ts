import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupIntermediates, planIntermediateCleanup } from '../src/cleanup.js';

test('cleanup dry-run plan includes only zips and extracted intermediates', () => {
  const root = mkTemp();
  mkdirSync(join(root, 'extracted'), { recursive: true });
  writeFileSync(join(root, 'win_0_139.zip'), 'zip');
  writeFileSync(join(root, 'keep.mp3'), 'audio');

  const plan = planIntermediateCleanup(root);

  assert.equal(plan.paths.length, 2);
  assert.ok(plan.paths.some((path) => path.endsWith('win_0_139.zip')));
  assert.ok(plan.paths.some((path) => path.endsWith('extracted')));
});

test('cleanup removes zips and extracted directory but preserves audio files', () => {
  const root = mkTemp();
  mkdirSync(join(root, 'extracted'), { recursive: true });
  writeFileSync(join(root, 'extracted', 'copy.mp3'), 'audio');
  writeFileSync(join(root, 'win_0_139.zip'), 'zip');
  writeFileSync(join(root, 'keep.mp3'), 'audio');

  cleanupIntermediates(root);

  assert.equal(existsSync(join(root, 'win_0_139.zip')), false);
  assert.equal(existsSync(join(root, 'extracted')), false);
  assert.equal(existsSync(join(root, 'keep.mp3')), true);
});

function mkTemp(): string {
  return join(tmpdir(), `amz-cleanup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
