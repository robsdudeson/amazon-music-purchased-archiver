import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AppPaths = {
  appRoot: string;
  downloads: string;
  staging: string;
  library: string;
  manifest: string;
  browserProfile: string;
};

export function defaultPaths(): AppPaths {
  const home = process.env.USERPROFILE || homedir();
  const appRoot = join(home, 'AmazonMusicPurchasedArchiver');

  return {
    appRoot,
    downloads: join(home, 'Downloads', 'AmazonMusicStaging'),
    staging: join(appRoot, 'staging'),
    library: join(home, 'Music', 'Amazon Purchased'),
    manifest: join(appRoot, 'manifest.csv'),
    browserProfile: join(appRoot, 'browser-profile'),
  };
}

export function ensurePaths(paths: AppPaths): void {
  for (const path of [paths.appRoot, paths.downloads, paths.staging, paths.library, paths.browserProfile]) {
    mkdirSync(path, { recursive: true });
  }
}
