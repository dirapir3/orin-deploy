import type { DurableSync, DurableStatus } from './sync.js';

let current: DurableSync | null = null;

export function setDurable(d: DurableSync | null): void {
  current = d;
}

export function getDurable(): DurableSync | null {
  return current;
}

/** Safe for the public health check: counts and flags only, never file names or values. */
export function durableHealth(): { enabled: boolean } & Partial<Omit<DurableStatus, 'skipped'>> & { skippedFiles?: number } {
  if (!current) return { enabled: false };
  const { skipped, ...s } = current.status();
  return { ...s, skippedFiles: skipped.length };
}
