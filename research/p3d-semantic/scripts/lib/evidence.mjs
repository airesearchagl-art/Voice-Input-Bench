import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESEARCH_ROOT } from './probes.mjs';

/**
 * Evidence files for the spike.
 *
 * A research number is only worth reading next to what produced it, so every
 * result file records the corpus digest, the endpoint, the model id, the prompt
 * digest where one applies, and the machine. Without those a rerun on another
 * day cannot be compared to this one, and the comparison is the entire point.
 */

export const EVIDENCE_DIR = path.join(RESEARCH_ROOT, 'evidence');

export function environmentSnapshot() {
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    total_memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
  };
}

export function writeEvidence(name, body) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/** Percentage with one decimal, or `n/a` when the denominator is zero. */
export function rate(numerator, denominator) {
  if (denominator === 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
