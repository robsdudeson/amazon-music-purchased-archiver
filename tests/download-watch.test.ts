import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadSnapshot, renameDownloadedZip, waitForStableNewZip } from '../src/download-watch.js';

test('waits for partial downloads to disappear before returning a zip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-watch-'));
  const before = downloadSnapshot(dir);
  writeFileSync(join(dir, 'AmazonMusicDownload.zip.crdownload'), 'partial');
  const waiting = waitForStableNewZip(dir, before, { pollMs: 10, stablePolls: 1, timeoutMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  renameSync(join(dir, 'AmazonMusicDownload.zip.crdownload'), join(dir, 'AmazonMusicDownload.zip'));

  assert.equal(await waiting, 'AmazonMusicDownload.zip');
});

test('renames downloaded zips uniquely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-watch-'));
  writeFileSync(join(dir, 'AmazonMusicDownload.zip'), 'zip');
  writeFileSync(join(dir, 'win_0_139.zip'), 'existing');

  const renamed = renameDownloadedZip(dir, 'AmazonMusicDownload.zip', 'win_0_139');

  assert.ok(renamed.endsWith('win_0_139 (2).zip'));
  assert.equal(existsSync(renamed), true);
});

test('times out without deleting partial files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-watch-'));
  const before = downloadSnapshot(dir);
  writeFileSync(join(dir, 'AmazonMusicDownload.zip.crdownload'), 'partial');

  assert.equal(await waitForStableNewZip(dir, before, { pollMs: 10, stablePolls: 1, timeoutMs: 30 }), undefined);
  assert.equal(existsSync(join(dir, 'AmazonMusicDownload.zip.crdownload')), true);
});
