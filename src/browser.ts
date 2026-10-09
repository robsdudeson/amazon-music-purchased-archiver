import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { organizeDownloads } from './organizer.js';
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
  const downloaded = await downloadRowsWhileScrolling(page, options.paths.downloads, maxBatches, pause, () => organizeAndReport(options.paths));
  console.log(`Started ${downloaded} download attempts from loaded rows.`);

  organizeAndReport(options.paths);
  await context.close();
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
  afterAttempt: () => void,
): Promise<number> {
  console.log('Processing visible rows while scrolling through lazy-loaded purchased tracks...');
  const processed = new Set<string>();
  let started = 0;
  let stablePasses = 0;
  let previousScrollY = -1;

  await page.keyboard.press('Home').catch(() => undefined);
  await page.waitForTimeout(1500);

  for (let pass = 1; pass <= 500 && started < maxDownloads && stablePasses < 6; pass++) {
    const beforeStarted = started;
    const rows = page.locator('music-image-row');
    const rowCount = await rows.count().catch(() => 0);
    console.log(`Pass ${pass}: ${rowCount} rows in DOM, ${processed.size} unique rows seen, ${started} downloads started.`);

    for (let i = 0; i < rowCount && started < maxDownloads; i++) {
      const row = rows.nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;

      const label = await row.locator('[role="button"][aria-label]').first().getAttribute('aria-label').catch(() => null);
      const key = label ?? await row.innerText().catch(() => `row-${pass}-${i}`);
      if (processed.has(key)) continue;
      processed.add(key);

      console.log(`Row ${processed.size}${label ? `: ${label}` : ''}`);
      const didDownload = await tryRowDownload(page, row, downloadDir);
      afterAttempt();

      if (didDownload) {
        started++;
        console.log(`Started download ${started}/${maxDownloads}.`);
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

function organizeAndReport(paths: AppPaths): void {
  const result = organizeDownloads(paths.downloads, paths.staging, paths.library, paths.manifest);
  if (result.extractedArchives || result.movedAudioFiles || result.duplicates || result.failures) {
    console.log(`Organized: ${result.extractedArchives} zips, ${result.movedAudioFiles} audio files, ${result.duplicates} duplicates, ${result.failures} failures.`);
  }
}
