#!/usr/bin/env node
/**
 * Verify the frozen probe corpus.
 *
 * Run this before reading any result file. It checks the digest, the shape of
 * every probe, and that the required hard cases are actually present — a corpus
 * that quietly lost `north side vs south side` would still produce a tidy
 * accuracy table, and the table would mean nothing.
 */

import { PROBES_FILE, loadProbes, recordedProbesSha256, sha256OfFile } from './lib/probes.mjs';

const REQUIRED_CASES = [
  { id: 'p13', why: 'north side vs south side' },
  { id: 'p14', why: '梁貫通で逃がさない vs 梁貫通で逃がす' },
  { id: 'p04', why: '2700mm vs 二千七百ミリ' },
  { id: 'p15', why: '2700mm vs 2600mm' },
  { id: 'p16', why: '午前10時 vs 午後10時' },
  { id: 'p01', why: 'GitHub vs github' },
  { id: 'p05', why: 'water closet vs ウォータークローゼット' },
  { id: 'p12', why: 'self-correction keeps the final intent' },
];

const MINIMUM_PROBES = 24;

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`ok    ${message}`);
}

const actual = sha256OfFile(PROBES_FILE);
const recorded = recordedProbesSha256();

if (actual !== recorded) {
  fail(`probe digest mismatch\n        recorded=${recorded}\n        actual  =${actual}`);
  process.exit(1);
}
ok(`probe digest ${actual}`);

const { probes, corpus } = loadProbes();

if (probes.length < MINIMUM_PROBES) {
  fail(`corpus has ${probes.length} probes, minimum is ${MINIMUM_PROBES}`);
} else {
  ok(`${probes.length} probes (minimum ${MINIMUM_PROBES})`);
}

const ids = new Set();
const allowedLabels = new Set(['preserved', 'changed']);
const allowedReasons = new Set(corpus.reason_codes);

for (const probe of probes) {
  const where = `probe ${probe.id ?? '(no id)'}`;
  if (typeof probe.id !== 'string' || probe.id.length === 0) fail(`${where}: missing id`);
  if (ids.has(probe.id)) fail(`${where}: duplicate id`);
  ids.add(probe.id);

  for (const field of ['category', 'reference', 'hypothesis']) {
    if (typeof probe[field] !== 'string' || probe[field].length === 0) {
      fail(`${where}: ${field} is missing or empty`);
    }
  }
  if (probe.reference === probe.hypothesis) fail(`${where}: reference and hypothesis are identical`);
  if (typeof probe.hard_negative !== 'boolean') fail(`${where}: hard_negative is not a boolean`);

  const gold = probe.gold;
  if (!gold || typeof gold !== 'object') {
    fail(`${where}: no gold label`);
    continue;
  }
  if (!allowedLabels.has(gold.label)) fail(`${where}: gold.label ${String(gold.label)} is not a label`);
  if (!allowedReasons.has(gold.reason_code)) {
    fail(`${where}: gold.reason_code ${String(gold.reason_code)} is not in reason_codes`);
  }
  if (typeof gold.note !== 'string' || gold.note.length === 0) fail(`${where}: gold.note is empty`);
}

if (process.exitCode !== 1) ok('every probe is well formed');

for (const required of REQUIRED_CASES) {
  if (!ids.has(required.id)) fail(`required hard case missing: ${required.id} (${required.why})`);
}
if (process.exitCode !== 1) ok(`all ${REQUIRED_CASES.length} required hard cases present`);

const preserved = probes.filter((probe) => probe.gold.label === 'preserved').length;
const changed = probes.length - preserved;
const hardNegatives = probes.filter((probe) => probe.hard_negative).length;

console.log('');
console.log(`      preserved      ${preserved}`);
console.log(`      changed        ${changed}`);
console.log(`      hard negatives ${hardNegatives}`);

if (preserved === 0 || changed === 0) {
  fail('a corpus with only one label cannot separate a method from a constant');
}

if (process.exitCode === 1) {
  console.error('\nprobe corpus verification FAILED');
} else {
  console.log('\nprobe corpus verified');
}
