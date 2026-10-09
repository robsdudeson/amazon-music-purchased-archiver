#!/usr/bin/env node
import { openForLogin, runDownloader } from './browser.js';
import { organizeDownloads } from './organizer.js';
import { defaultPaths, ensurePaths } from './paths.js';

function usage(): void {
  console.log(`Amazon Music Purchased Archiver

Usage:
  npm run dev -- init
  npm run dev -- login
  npm run dev -- run [--max-batches N] [--headless] [--batch-pause-ms N]
  npm run dev -- organize

Commands:
  init       Create Windows folders used by the tool.
  login      Open a persistent browser profile so you can sign into Amazon manually.
  run        Visit Amazon Music Purchased and click visible Download controls.
  organize   Extract ZIPs, dedupe audio files, and update the manifest.
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

function numberArg(argv: string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
