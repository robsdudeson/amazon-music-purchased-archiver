import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { Manifest, trackKey } from './manifest.js';
import { organizeDownloads, type DownloadMetadata } from './organizer.js';
import { mergeVisibleRows, snapshotSongs, writePurchasedSongSnapshot, type PurchasedSong } from './purchased-list.js';
import { downloadSnapshot, renameDownloadedZip, waitForStableNewZip } from './download-watch.js';
import { parseWindowSpec, planDownloadWindows, validateSelectionCount, type DownloadWindow } from './window-plan.js';
import type { AppPaths } from './paths.js';

const PURCHASED_URL = 'https://music.amazon.com/recently/purchased';

type RunOptions = {
  paths: AppPaths;
  headless?: boolean;
  maxBatches?: number;
  batchPauseMs?: number;
};

export async function openForLogin(paths: AppPaths): Promise<void> {
  const context = await launchPersistent(paths, false);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(PURCHASED_URL, { waitUntil: 'domcontentloaded' });
  console.log('\nBrowser opened. Log into Amazon manually, then press Ctrl+C here when finished.');
  await new Promise(() => undefined);
}

export async function runDownloader(options: RunOptions): Promise<void> {
  const context = await launchPersistent(options.paths, Boolean(options.headless));
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(PURCHASED_URL, { waitUntil: 'domcontentloaded' });
  await waitForAmazonMusicUi(page);

  console.log('Opened Amazon Music Purchased page.');
  console.log('This automation clicks each track row three-dots menu, then its Download item. It will not bypass captchas, MFA, DRM, or subscription-only restrictions.');

  const maxBatches = options.maxBatches ?? 1000;
  const pause = options.batchPauseMs ?? 3000;
  const manifest = new Manifest(options.paths.manifest);
  const knownTrackKeys = manifest.knownTrackKeys();
  const downloaded = await downloadRowsWhileScrolling(page, options.paths.downloads, maxBatches, pause, knownTrackKeys, () => organizeAndReport(options.paths));
  console.log(`Started ${downloaded} download attempts from loaded rows.`);

  organizeAndReport(options.paths);
  await context.close();
}

export async function capturePurchasedList(paths: AppPaths, headless = false): Promise<void> {
  const context = await launchPersistent(paths, headless);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(PURCHASED_URL, { waitUntil: 'domcontentloaded' });
  await waitForAmazonMusicUi(page);

  let songs: PurchasedSong[] = [];
  let stablePasses = 0;
  let previousCount = -1;
  let previousTop = -1;
  for (let pass = 1; pass <= 500 && stablePasses < 8; pass++) {
    const visible = await visiblePurchasedRows(page);
    songs = mergeVisibleRows(songs, visible);
    const scroll = await page.evaluate(() => ({ top: document.scrollingElement?.scrollTop ?? window.scrollY, max: (document.scrollingElement?.scrollHeight ?? 0) - (document.scrollingElement?.clientHeight ?? 0) }));
    console.log(`Capture pass ${pass}: ${visible.length} visible, ${songs.length} unique, scroll ${Math.round(scroll.top)}/${Math.round(scroll.max)}`);
    if (songs.length === previousCount && Math.abs(scroll.top - previousTop) < 3) stablePasses++;
    else stablePasses = 0;
    previousCount = songs.length;
    previousTop = scroll.top;
    await page.evaluate(() => document.scrollingElement?.scrollBy(0, 2200));
    await page.waitForTimeout(700);
  }

  const snapshot = snapshotSongs(songs);
  writePurchasedSongSnapshot(snapshot, join(paths.appRoot, 'purchased-songs.json'), join(paths.appRoot, 'purchased-songs.csv'));
  console.log(`Captured ${snapshot.count} purchased songs.`);
  await context.close();
}

export async function runWindowedDownloader(options: RunOptions & { windows?: string[] }): Promise<void> {
  const context = await launchPersistent(options.paths, Boolean(options.headless));
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(PURCHASED_URL, { waitUntil: 'domcontentloaded' });
  await waitForAmazonMusicUi(page);

  const purchasedPath = join(options.paths.appRoot, 'purchased-songs.json');
  const purchased = JSON.parse(readFileSync(purchasedPath, 'utf8')) as { songs: PurchasedSong[] };
  const windows = options.windows?.length ? options.windows.map(parseWindowSpec) : planDownloadWindows({ total: purchased.songs.length });
  const maxWindows = options.maxBatches ?? windows.length;
  const pause = options.batchPauseMs ?? 3000;
  console.log(`Windowed download plan: ${windows.length} windows for ${purchased.songs.length} songs.`);
  const results: Array<{ label: string; start: number; end: number; targetCount: number; selectedCount: number; status: 'skipped' | 'downloaded' | 'failed'; zipPath?: string; error?: string }> = [];

  for (const window of windows.slice(0, maxWindows)) {
    const targetPath = join(options.paths.downloads, `${window.label}.zip`);
    if (existsSync(targetPath)) {
      console.log(`Skipping ${window.label}; zip already exists.`);
      results.push({ label: window.label, start: window.start, end: window.end, targetCount: window.size, selectedCount: 0, status: 'skipped', zipPath: targetPath });
      continue;
    }
    const keys = purchased.songs.slice(window.start, window.end).map((song) => song.key);
    console.log(`Selecting ${window.label}: positions ${window.start}..${window.end - 1} (${keys.length} targets)`);
    const selected = await selectRowsByKeys(page, keys);
    try {
      validateSelectionCount(selected, keys.length, { min: Math.min(60, keys.length) });
      const before = downloadSnapshot(options.paths.downloads);
      await clickToolbarDownload(page);
      const zip = await waitForStableNewZip(options.paths.downloads, before);
      if (!zip) {
        console.log(`No stable zip appeared for ${window.label}; rerun this range later.`);
        results.push({ label: window.label, start: window.start, end: window.end, targetCount: keys.length, selectedCount: selected, status: 'failed', error: 'zip timeout' });
      } else {
        const zipPath = renameDownloadedZip(options.paths.downloads, zip, window.label);
        console.log(`Saved ${zipPath}`);
        results.push({ label: window.label, start: window.start, end: window.end, targetCount: keys.length, selectedCount: selected, status: 'downloaded', zipPath });
      }
    } catch (error) {
      results.push({ label: window.label, start: window.start, end: window.end, targetCount: keys.length, selectedCount: selected, status: 'failed', error: String(error) });
      console.log(`Window ${window.label} failed: ${error}`);
    }
    await clearSelection(page);
    await page.waitForTimeout(pause);
  }

  const reportPath = join(options.paths.appRoot, 'window-download-report.json');
  writeFileSync(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
  const failed = results.filter((result) => result.status === 'failed');
  await context.close();
  if (failed.length) throw new Error(`${failed.length} download window(s) failed. See ${reportPath}. Rerun with ${failed.map((result) => `--window ${result.start}-${result.end}`).join(' ')}`);
}

async function launchPersistent(paths: AppPaths, headless: boolean): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(paths.browserProfile, {
    headless,
    acceptDownloads: true,
    downloadsPath: paths.downloads,
    viewport: { width: 1440, height: 1000 },
  });

  // Chromium normally stores Playwright downloads in a temporary artifact
  // directory until `download.saveAs(...)` runs. Force the browser-level default
  // as well so Amazon-triggered downloads land somewhere readable on Windows.
  const browser = context.browser();
  if (browser) {
    const cdp = await browser.newBrowserCDPSession().catch(() => null);
    await cdp?.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: paths.downloads,
      eventsEnabled: true,
    }).catch(() => undefined);
  }

  console.log(`Browser profile: ${paths.browserProfile}`);
  console.log(`Download directory: ${paths.downloads}`);
  return context;
}

async function waitForAmazonMusicUi(page: Page): Promise<void> {
  console.log('Waiting for Amazon Music UI to finish loading...');
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);

  const readySignal = page.locator([
    'button[aria-label*="more" i]',
    'button[aria-label*="option" i]',
    'button[aria-label*="action" i]',
    '[role="row"]',
    'music-horizontal-item',
    'music-image-row',
    '[data-testid*="track" i]',
    '[data-testid*="song" i]',
  ].join(', ')).first();

  await readySignal.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(5_000);
}

async function downloadRowsWhileScrolling(
  page: Page,
  downloadDir: string,
  maxDownloads: number,
  pauseMs: number,
  knownTrackKeys: Set<string>,
  afterAttempt: () => void,
): Promise<number> {
  console.log('Processing visible rows in bulk while scrolling through lazy-loaded purchased tracks...');
  const processed = new Set<string>();
  let started = 0;
  let stablePasses = 0;
  let previousScrollY = -1;
  const batchSize = 50;

  await page.keyboard.press('Home').catch(() => undefined);
  await page.waitForTimeout(1500);

  for (let pass = 1; pass <= 500 && started < maxDownloads && stablePasses < 6; pass++) {
    const beforeStarted = started;
    const visibleRows = await visibleTrackRows(page);
    console.log(`Pass ${pass}: ${visibleRows.length} visible rows, ${processed.size} unique rows seen, ${started} downloads started.`);

    const batch: VisibleTrackRow[] = [];
    for (const row of visibleRows) {
      if (batch.length >= batchSize || started + batch.length >= maxDownloads) break;

      const metadata = parseRowLabel(row.label);
      const persistedKey = trackKey(metadata.title, metadata.artist, metadata.album);
      const key = row.label || row.text || `row-${pass}-${row.index}`;
      if (processed.has(key)) continue;
      processed.add(key);
      if (persistedKey && knownTrackKeys.has(persistedKey)) {
        console.log(`Skipping previously recorded row ${processed.size}${row.label ? `: ${row.label}` : ''}`);
        continue;
      }

      batch.push(row);
    }

    if (batch.length > 0) {
      console.log(`Selecting ${batch.length} rows for bulk download.`);
      const didDownload = await tryBulkDownload(page, batch, downloadDir);
      afterAttempt();

      if (didDownload) {
        for (const row of batch) {
          const metadata = parseRowLabel(row.label);
          const persistedKey = trackKey(metadata.title, metadata.artist, metadata.album);
          if (persistedKey) knownTrackKeys.add(persistedKey);
        }
        started += batch.length;
        console.log(`Started bulk download for ${batch.length} selected rows (${started}/${maxDownloads}).`);
        await page.waitForTimeout(pauseMs);
      }
    }

    const previous = await page.evaluate(() => window.scrollY).catch(() => 0);
    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(2500);
    const current = await page.evaluate(() => window.scrollY).catch(() => 0);

    if (started === beforeStarted && current === previousScrollY && current === previous) stablePasses++;
    else stablePasses = 0;
    previousScrollY = current;
  }

  return started;
}

type VisibleTrackRow = {
  index: number;
  label: string | null;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

async function visiblePurchasedRows(page: Page): Promise<Omit<PurchasedSong, 'position'>[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('music-image-row[primary-text]')).map((element) => ({
    key: element.getAttribute('data-key') ?? '',
    title: element.getAttribute('primary-text') ?? '',
    artist: element.getAttribute('secondary-text-1') ?? '',
    album: element.getAttribute('secondary-text-2') ?? '',
    duration: element.getAttribute('tertiary-text') ?? undefined,
  })).filter((row) => row.key && row.title));
}

async function selectRowsByKeys(page: Page, keys: string[]): Promise<number> {
  await clearSelection(page);
  await page.evaluate(() => { document.scrollingElement?.scrollTo(0, 0); window.scrollTo(0, 0); });
  await page.waitForTimeout(700);
  const targets = new Set(keys);
  const selected = new Set<string>();
  await page.keyboard.down('Control');
  try {
    for (let guard = 0; selected.size < targets.size && guard < 600; guard++) {
      const visible = await page.evaluate(() => Array.from(document.querySelectorAll('music-image-row[primary-text]')).map((element) => {
        const rect = element.getBoundingClientRect();
        return { key: element.getAttribute('data-key') ?? '', x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }).filter((row) => row.width > 0 && row.height > 0));

      let clicked = 0;
      for (const row of visible) {
        if (!targets.has(row.key) || selected.has(row.key) || row.y < 120 || row.y > 980) continue;
        await page.mouse.click(row.x + Math.min(500, row.width / 2), row.y + row.height / 2);
        selected.add(row.key);
        clicked++;
        await page.waitForTimeout(35);
      }
      if (selected.size >= targets.size) break;
      const scroll = await page.evaluate(() => ({ top: document.scrollingElement?.scrollTop ?? window.scrollY, max: (document.scrollingElement?.scrollHeight ?? 0) - (document.scrollingElement?.clientHeight ?? 0) }));
      if (clicked === 0 && scroll.top >= scroll.max - 5) break;
      await page.evaluate(() => document.scrollingElement?.scrollBy(0, 700));
      await page.waitForTimeout(250);
    }
  } finally {
    await page.keyboard.up('Control').catch(() => undefined);
  }
  await page.waitForTimeout(500);
  return selectedRowCount(page);
}

async function clickToolbarDownload(page: Page): Promise<void> {
  const menuButton = await toolbarMenuButton(page);
  if (!menuButton) throw new Error('No selected-row toolbar menu found.');
  await menuButton.click({ timeout: 5000 });
  await page.waitForTimeout(400);
  const downloadItem = page.locator('music-list-item[primary-text^="Download"]').or(page.getByRole('menuitem', { name: /download/i })).first();
  if (!(await downloadItem.isVisible().catch(() => false))) throw new Error('Toolbar menu opened, but no Download item was visible.');
  await downloadItem.click({ timeout: 5000 });
}

async function visibleTrackRows(page: Page): Promise<VisibleTrackRow[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('music-image-row')).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const label = element.querySelector('[role="button"][aria-label]')?.getAttribute('aria-label') || null;
    return {
      index,
      label,
      text: (element.textContent ?? '').trim().replace(/\s+/g, ' '),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }).filter((row) => row.width > 0 && row.height > 0 && row.text.length > 0 && row.y >= 140 && row.y < window.innerHeight - 20));
}

async function tryBulkDownload(page: Page, rows: VisibleTrackRow[], downloadDir: string): Promise<boolean> {
  await clearSelection(page);

  await page.keyboard.down('Control');
  try {
    for (const row of rows) {
      await page.mouse.click(row.x + Math.min(500, row.width / 2), row.y + row.height / 2);
      await page.waitForTimeout(150);
    }
  } finally {
    await page.keyboard.up('Control').catch(() => undefined);
  }

  const selectedCount = await selectedRowCount(page);
  if (selectedCount === 0) {
    console.log('Bulk selection did not select any rows; falling back to row menus for this pass.');
    let any = false;
    for (const row of rows) {
      const locator = page.locator('music-image-row').nth(row.index);
      any = (await tryRowDownload(page, locator, downloadDir)) || any;
    }
    return any;
  }

  const menuButton = await toolbarMenuButton(page);
  if (!menuButton) {
    console.log('Selected rows, but no bulk action menu was visible.');
    await clearSelection(page);
    return false;
  }

  await menuButton.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(400);

  const before = await downloadDirectorySnapshot(downloadDir);
  const downloadItem = page.locator('music-list-item[primary-text^="Download"]').or(page.getByRole('menuitem', { name: /download/i })).first();
  if (!(await downloadItem.isVisible().catch(() => false))) {
    console.log('Opened bulk action menu, but no Download item was visible.');
    await page.keyboard.press('Escape').catch(() => undefined);
    await clearSelection(page);
    return false;
  }

  await downloadItem.click({ timeout: 5000 }).catch(() => undefined);
  await waitForDownloadsToSettle(downloadDir, before);
  await clearSelection(page);
  return true;
}

async function toolbarMenuButton(page: Page): Promise<Locator | null> {
  const buttons = page.locator('button[aria-label="Opens menu"]');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const box = await button.boundingBox().catch(() => null);
    if (box && box.y < 160) return button;
  }
  return null;
}

async function selectedRowCount(page: Page): Promise<number> {
  const selectedText = await page.locator('text=/\\d+ selected/i').first().textContent({ timeout: 1000 }).catch(() => null);
  const match = selectedText?.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

async function clearSelection(page: Page): Promise<void> {
  const dismiss = page.locator('button[aria-label="Dismiss"]').first();
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

async function downloadDirectorySnapshot(downloadDir: string): Promise<Map<string, number>> {
  mkdirSync(downloadDir, { recursive: true });
  const snapshot = new Map<string, number>();
  for (const entry of readdirSync(downloadDir, { withFileTypes: true })) {
    if (entry.isFile()) snapshot.set(entry.name, statSync(join(downloadDir, entry.name)).size);
  }
  return snapshot;
}

async function waitForDownloadsToSettle(downloadDir: string, before: Map<string, number>): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await downloadDirectorySnapshot(downloadDir);
    const inProgress = Array.from(after.keys()).some((name) => name.endsWith('.crdownload') || name.endsWith('.part'));
    const changed = !sameSnapshot(before, after);
    if (changed && !inProgress) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
  }
}

function sameSnapshot(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

async function tryRowDownload(page: Page, row: Locator, downloadDir: string): Promise<boolean> {
  await row.hover().catch(() => undefined);
  await page.waitForTimeout(250);

  const menu = row.locator([
    'button[aria-label="Opens menu"]',
    'button[aria-label*="more" i]',
    'button[aria-label*="option" i]',
    'button[aria-label*="action" i]',
    'button[title*="more" i]',
    'button[title*="option" i]',
    'button[title*="action" i]',
  ].join(', ')).first();

  return openMenuAndDownload(page, menu, downloadDir);
}

async function openMenuAndDownload(page: Page, menuButton: Locator, downloadDir: string): Promise<boolean> {
  if (!(await menuButton.isVisible().catch(() => false))) return false;

  await menuButton.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(400);

  const menuDownload = page
    .locator('music-list-item[primary-text="Download"]')
    .or(page.getByRole('menuitem', { name: /download/i }))
    .or(page.getByRole('button', { name: /^\s*download\s*$/i }))
    .or(page.getByRole('link', { name: /^\s*download\s*$/i }))
    .or(page.getByText(/^\s*Download\s*$/i))
    .first();

  if (await menuDownload.isVisible().catch(() => false)) {
    return clickAndSave(page, menuDownload, downloadDir);
  }

  console.log('Opened row menu, but no Download menu item was visible.');
  await page.keyboard.press('Escape').catch(() => undefined);
  return false;
}

async function clickAndSave(page: Page, locator: Locator, downloadDir: string): Promise<boolean> {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
  await locator.click({ timeout: 5000 }).catch(() => undefined);
  const download = await downloadPromise;
  if (!download) {
    console.log('No Playwright download event was observed after clicking Download.');
    return false;
  }

  const suggested = download.suggestedFilename();
  const destination = join(downloadDir, suggested);
  mkdirSync(downloadDir, { recursive: true });
  console.log(`Saving download as: ${destination}`);

  try {
    await download.saveAs(destination);
    return true;
  } catch (error) {
    // When CDP Browser.setDownloadBehavior is active, Chromium may already put
    // the final file in the download directory before Playwright can copy its
    // temporary artifact. Treat that as success instead of crashing.
    if (await waitForDownloadedFile(downloadDir, suggested)) {
      console.log(`Download already present in target directory: ${destination}`);
      return true;
    }
    throw error;
  }
}

async function waitForDownloadedFile(downloadDir: string, suggested: string): Promise<boolean> {
  const target = join(downloadDir, suggested);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (existsSync(target) && statSync(target).size > 0) return true;

    const matchingFinishedFile = readdirSync(downloadDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .some((entry) => entry.name === suggested && !entry.name.endsWith('.crdownload'));
    if (matchingFinishedFile) return true;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function parseRowLabel(label: string | null): DownloadMetadata {
  if (!label) return {};

  const parts = label.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return { title: label };

  const album = parts.at(-1);
  const artist = parts.at(-2);
  const title = parts.slice(0, -2).join(', ');
  return { title, artist, album };
}

function organizeAndReport(paths: AppPaths, metadata: DownloadMetadata = {}): void {
  const result = organizeDownloads(paths.downloads, paths.staging, paths.library, paths.manifest, metadata);
  if (result.extractedArchives || result.movedAudioFiles || result.duplicates || result.failures) {
    console.log(`Organized: ${result.extractedArchives} zips, ${result.movedAudioFiles} audio files, ${result.duplicates} duplicates, ${result.failures} failures.`);
  }
}
