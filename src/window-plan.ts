export type DownloadWindow = {
  start: number;
  end: number;
  size: number;
  label: string;
};

export type WindowPlanOptions = {
  total: number;
  size?: number;
  step?: number;
  minZipSize?: number;
};

export function planDownloadWindows(options: WindowPlanOptions): DownloadWindow[] {
  const size = options.size ?? 140;
  const step = options.step ?? 90;
  const minZipSize = options.minZipSize ?? 100;
  if (!Number.isInteger(options.total) || options.total < 0) throw new Error('total must be a non-negative integer');
  if (!Number.isInteger(size) || size <= 0) throw new Error('size must be a positive integer');
  if (!Number.isInteger(step) || step <= 0) throw new Error('step must be a positive integer');

  const windows: DownloadWindow[] = [];
  for (let start = 0; start < options.total; start += step) {
    const end = Math.min(options.total, start + size);
    if (end === options.total && end - start < minZipSize && options.total > minZipSize) {
      const shifted = makeWindow(Math.max(0, options.total - size), options.total);
      const previous = windows.at(-1);
      if (!previous || previous.start !== shifted.start || previous.end !== shifted.end) windows.push(shifted);
      break;
    }
    windows.push(makeWindow(start, end));
  }
  return windows;
}

export function parseWindowSpec(spec: string): DownloadWindow {
  const match = spec.match(/^(\d+)-(\d+)$/);
  if (!match) throw new Error(`Invalid window spec: ${spec}. Expected START-END with END exclusive.`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw new Error(`Invalid window bounds: ${spec}`);
  return makeWindow(start, end);
}

export function makeWindow(start: number, end: number): DownloadWindow {
  return { start, end, size: end - start, label: `win_${start}_${end - 1}` };
}

export function validateSelectionCount(actual: number, target: number, options: { min?: number; tolerance?: number } = {}): void {
  const min = options.min ?? Math.min(target, 60);
  const tolerance = options.tolerance ?? 5;
  if (actual < min) throw new Error(`Too few selected rows: ${actual} selected for ${target} targets`);
  if (actual > target + tolerance) throw new Error(`Too many selected rows: ${actual} selected for ${target} targets; possible stale selection`);
}
