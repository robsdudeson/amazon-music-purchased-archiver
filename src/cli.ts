#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capturePurchasedList, openForLogin, runDownloader, runWindowedDownloader } from './browser.js';
import { cleanupIntermediates, planIntermediateCleanup } from './cleanup.js';
import { consolidateLibrary, extractArchives } from './consolidator.js';
import { organizeDownloads } from './organizer.js';
import { defaultPaths, ensurePaths } from './paths.js';
import type { PurchasedSongSnapshot } from './purchased-list.js';
import { reconcilePurchasedLibrary, writeReconcileReport } from './reconcile.js';
import { normalizeTagsFromPath } from './tag-normalizer.js';

function usage(): void {
  console.log(`Amazon Music Purchased Archiver

Usage:
  npm run dev -- init
  npm run dev -- login
  npm run dev -- capture-list [--headless]
  npm run dev -- download-windows [--max-batches N] [--batch-pause-ms N] [--window START-END]
  npm run dev -- consolidate
  npm run dev -- reconcile
  npm run dev -- normalize-tags
  npm run dev -- cleanup [--yes]
  npm run dev -- run [--max-batches N] [--headless] [--batch-pause-ms N]
  npm run dev -- organize

Commands:
  init              Create Windows folders used by the tool.
  login             Open a persistent browser profile so you can sign into Amazon manually.
  capture-list      Scroll the purchased list and save purchased-songs.json/csv.
  download-windows  Download overlapping >100-song windows as stable renamed ZIPs.
  consolidate       Extract ZIPs and merge distinct Artist/Album/filename recordings into Purchased/.
  reconcile         Compare captured purchase count with the consolidated library.
  normalize-tags    Write basic ID3 tags from Artist/Album/NN - Title.mp3 paths.
  cleanup           Remove downloaded ZIPs and extracted intermediates after consolidation.
  run               Legacy visible-row downloader.
  organize          Legacy extract/dedupe into Unsorted.
`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const paths = defaultPaths();
  ensurePaths(paths);

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'init') {
    console.log('Created folders:');
    console.log(paths);
    return;
  }

  if (command === 'login') {
    await openForLogin(paths);
    return;
  }

  if (command === 'capture-list') {
    await capturePurchasedList(paths, argv.includes('--headless'));
    return;
  }

  if (command === 'download-windows') {
    await runWindowedDownloader({
      paths,
      headless: argv.includes('--headless'),
      maxBatches: numberArg(argv, '--max-batches'),
      batchPauseMs: numberArg(argv, '--batch-pause-ms'),
      windows: repeatedArg(argv, '--window'),
    });
    return;
  }

  if (command === 'consolidate') {
    const extracted = join(paths.downloads, 'extracted');
    const extractedArchives = extractArchives(paths.downloads, extracted);
    const purchased = loadPurchased(paths);
    const result = consolidateLibrary({
      extractedDir: extracted,
      unsortedDir: join(paths.library, 'Unsorted'),
      outputDir: join(paths.library, 'Purchased'),
      purchasedSongs: purchased?.songs,
    });
    const report = { ...result, extractedArchives };
    writeFileSync(join(paths.appRoot, 'consolidation-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(report);
    return;
  }

  if (command === 'reconcile') {
    const purchased = loadPurchased(paths);
    if (!purchased) throw new Error(`Run capture-list first; missing ${join(paths.appRoot, 'purchased-songs.json')}`);
    const report = reconcilePurchasedLibrary(purchased.songs, join(paths.library, 'Purchased'));
    writeReconcileReport(report, join(paths.appRoot, 'reconcile-report.json'));
    console.log(report);
    return;
  }

  if (command === 'normalize-tags') {
    const result = normalizeTagsFromPath(join(paths.library, 'Purchased'));
    writeFileSync(join(paths.appRoot, 'tag-normalization-report.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(result);
    return;
  }

  if (command === 'cleanup') {
    const plan = planIntermediateCleanup(paths.downloads);
    if (!argv.includes('--yes')) {
      console.log('Dry run. Pass --yes to delete:');
      console.log(plan);
      return;
    }
    if (!argv.includes('--force')) assertCleanupAllowed(paths);
    console.log(cleanupIntermediates(paths.downloads));
    return;
  }

  if (command === 'organize') {
    const result = organizeDownloads(paths.downloads, paths.staging, paths.library, paths.manifest);
    console.log(result);
    console.log(`Library: ${paths.library}`);
    console.log(`Manifest: ${paths.manifest}`);
    return;
  }

  if (command === 'run') {
    await runDownloader({
      paths,
      headless: argv.includes('--headless'),
      maxBatches: numberArg(argv, '--max-batches'),
      batchPauseMs: numberArg(argv, '--batch-pause-ms'),
    });
    return;
  }

  usage();
  process.exitCode = 1;
}

function loadPurchased(paths: ReturnType<typeof defaultPaths>): PurchasedSongSnapshot | undefined {
  const path = join(paths.appRoot, 'purchased-songs.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as PurchasedSongSnapshot;
}

function numberArg(argv: string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

function repeatedArg(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}

function assertCleanupAllowed(paths: ReturnType<typeof defaultPaths>): void {
  const reportPath = join(paths.appRoot, 'consolidation-report.json');
  if (!existsSync(reportPath)) throw new Error(`Refusing cleanup: missing ${reportPath}. Run consolidate first, or pass --force.`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { unmatched?: unknown[]; total?: number };
  if ((report.unmatched?.length ?? 0) > 0) throw new Error(`Refusing cleanup: consolidation report has ${report.unmatched?.length} unmatched files. Review them or pass --force.`);
  if (!report.total || report.total <= 0) throw new Error('Refusing cleanup: consolidation report does not show a successful output. Run consolidate first, or pass --force.');
  const reportMtime = statSync(reportPath).mtimeMs;
  const cleanupPlan = planIntermediateCleanup(paths.downloads);
  const newer = cleanupPlan.paths.find((path) => statSync(path).mtimeMs > reportMtime);
  if (newer) throw new Error(`Refusing cleanup: ${newer} is newer than the consolidation report. Rerun consolidate first, or pass --force.`);
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
