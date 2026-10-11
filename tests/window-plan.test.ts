import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWindowSpec, planDownloadWindows, validateSelectionCount } from '../src/window-plan.js';

test('plans overlapping windows that cover a 779-track library including the tail', () => {
  const windows = planDownloadWindows({ total: 779, size: 140, step: 90 });

  assert.equal(windows[0].start, 0);
  assert.equal(windows[0].end, 140);
  assert.equal(windows.at(-1)?.start, 639);
  assert.equal(windows.at(-1)?.end, 779);
  assert.ok((windows.at(-1)?.size ?? 0) >= 100);
  for (let i = 0; i < 779; i++) {
    assert.ok(windows.some((window) => i >= window.start && i < window.end), `position ${i} is covered`);
  }
});

test('parses explicit window specs as end-exclusive ranges', () => {
  assert.deepEqual(parseWindowSpec('672-778'), { start: 672, end: 778, size: 106, label: 'win_672_777' });
});

test('selection validation catches low and stale selection counts', () => {
  assert.throws(() => validateSelectionCount(0, 106), /Too few/);
  assert.throws(() => validateSelectionCount(120, 106), /Too many/);
  assert.doesNotThrow(() => validateSelectionCount(103, 106));
});
