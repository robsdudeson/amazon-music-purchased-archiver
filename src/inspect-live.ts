import { chromium, type Locator, type Page } from 'playwright';

const cdp = process.argv.find((arg) => arg.startsWith('--cdp='))?.slice('--cdp='.length) ?? 'http://127.0.0.1:9222';
const shouldProbeMenu = process.argv.includes('--probe-menu');

const menuSelectors = [
  'button[aria-label*="more" i]',
  'button[aria-label*="option" i]',
  'button[aria-label*="action" i]',
  'button[aria-label="Opens menu"]',
  'button[title*="more" i]',
  'button[title*="option" i]',
  'button[title*="action" i]',
  'button:has-text("⋯")',
  'button:has-text("…")',
  'button:has-text("⋮")',
  '[role="button"][aria-label*="more" i]',
  '[role="button"][aria-label*="option" i]',
  '[role="button"][aria-label*="action" i]',
  '[role="button"][aria-label="Opens menu"]',
];

const rowSelectors = [
  '[role="row"]',
  'music-horizontal-item',
  'music-image-row',
  '.music-horizontal-item',
  '[data-testid*="track" i]',
  '[data-testid*="song" i]',
];

async function main(): Promise<void> {
  const browser = await chromium.connectOverCDP(cdp);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('music.amazon.com')) ?? context.pages()[0];

  if (!page) throw new Error('No open page found in the connected browser.');

  console.log(`Connected to: ${page.url()}`);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);

  await dumpPageSignals(page);

  if (shouldProbeMenu) {
    await probeFirstMenu(page);
  }

  await browser.close();
}

async function dumpPageSignals(page: Page): Promise<void> {
  console.log('\n=== Page title ===');
  console.log(await page.title().catch(() => '(no title)'));

  console.log('\n=== Candidate row counts ===');
  for (const selector of rowSelectors) {
    console.log(`${selector}: ${await page.locator(selector).count().catch(() => 0)}`);
  }

  console.log('\n=== Candidate menu button counts ===');
  for (const selector of menuSelectors) {
    console.log(`${selector}: ${await page.locator(selector).count().catch(() => 0)}`);
  }

  console.log('\n=== Visible buttons/roles sample ===');
  const buttons = await page.locator('button, [role="button"]').evaluateAll((els) =>
    els.slice(0, 80).map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().slice(0, 80),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      role: el.getAttribute('role'),
      testid: el.getAttribute('data-testid'),
      classes: el.getAttribute('class')?.slice(0, 120),
    })),
  );
  console.log(JSON.stringify(buttons, null, 2));
}

async function probeFirstMenu(page: Page): Promise<void> {
  console.log('\n=== Probing first likely track menu ===');
  const menu = await findFirstMenu(page);
  if (!menu) {
    console.log('No menu candidate found.');
    return;
  }

  await menu.hover().catch(() => undefined);
  await menu.click({ timeout: 5_000 }).catch((error) => console.log(`Menu click failed: ${error}`));
  await page.waitForTimeout(1_000);

  const items = await page.locator('[role="menuitem"], [role="option"], button, a, music-button')
    .evaluateAll((els) => els.slice(0, 120).map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().slice(0, 100),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      role: el.getAttribute('role'),
      testid: el.getAttribute('data-testid'),
      classes: el.getAttribute('class')?.slice(0, 120),
    })));

  console.log(JSON.stringify(items, null, 2));
  await page.screenshot({ path: 'amazon-music-menu-probe.png', fullPage: false }).catch(() => undefined);
  console.log('Screenshot written to amazon-music-menu-probe.png if supported.');
}

async function findFirstMenu(page: Page): Promise<Locator | null> {
  for (const rowSelector of rowSelectors) {
    const rows = page.locator(rowSelector);
    const rowCount = Math.min(await rows.count().catch(() => 0), 20);
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      await row.hover().catch(() => undefined);
      await page.waitForTimeout(250);
      const menu = row.locator(menuSelectors.join(', ')).first();
      if (await menu.isVisible().catch(() => false)) return menu;
    }
  }

  const pageMenu = page.locator(menuSelectors.join(', ')).first();
  if (await pageMenu.isVisible().catch(() => false)) return pageMenu;
  return null;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
