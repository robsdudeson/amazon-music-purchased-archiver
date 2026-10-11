import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CleanupPlan = {
  paths: string[];
  bytes: number;
};

export function planIntermediateCleanup(incomingDir: string): CleanupPlan {
  const paths: string[] = [];
  let bytes = 0;
  if (!existsSync(incomingDir)) return { paths, bytes };

  for (const entry of readdirSync(incomingDir)) {
    const path = join(incomingDir, entry);
    if (entry.toLowerCase().endsWith('.zip') || entry === 'extracted') {
      paths.push(path);
      bytes += sizeOf(path);
    }
  }

  return { paths, bytes };
}

export function cleanupIntermediates(incomingDir: string): CleanupPlan {
  const plan = planIntermediateCleanup(incomingDir);
  for (const path of plan.paths) rmSync(path, { recursive: true, force: true });
  return plan;
}

function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
  return total;
}
