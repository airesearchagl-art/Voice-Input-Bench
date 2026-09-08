#!/usr/bin/env node
/**
 * Bring stored LLM evidence up to the two-level unanimity semantics.
 *
 * R1's evidence files carry a single `unanimous` flag computed over the valid
 * runs only, so a pair with two agreeing runs and one unparseable reply is
 * recorded as unanimous. That flag is now known to be misleading, and leaving it
 * in a file the analysis no longer reads would be worse than either removing it
 * or fixing it: a reader would find it and believe it.
 *
 * This rewrites **only derived fields**, recomputed from the `runs[]` already in
 * the file:
 *
 *   - `unanimous` is replaced by `valid_vote_unanimous` and `full_run_unanimous`
 *   - `requested_runs` and `changed_votes` are added
 *
 * Nothing else is touched. No request is replayed, no response is re-fetched, no
 * hash is recomputed from anything but what is already recorded, and
 * `started_at` / `finished_at` / `latency_ms` / every entry of `runs[]` are left
 * byte-for-byte as the run wrote them.
 *
 * Fail Closed: if a recomputed tally disagrees with the counts already stored —
 * `valid_runs`, `invalid_runs`, `preserved_votes`, `majority_label` — the file
 * is left alone and the script exits non-zero. A disagreement there means the
 * stored runs are not the runs the stored summary was computed from, and a
 * backfill would paper over that rather than surface it.
 *
 * Usage: node scripts/backfill-vote-semantics.mjs [--check]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR } from './lib/evidence.mjs';
import { tallyRuns } from './lib/voteSemantics.mjs';

const checkOnly = process.argv.includes('--check');
const FILES = ['llm-rubric-results.raw.json', 'llm-rubric-results.surface.json'];

let changedFiles = 0;
let problems = 0;

for (const name of FILES) {
  const file = path.join(EVIDENCE_DIR, name);
  if (!existsSync(file)) {
    console.log(`${name.padEnd(34)} absent, skipped`);
    continue;
  }

  const evidence = JSON.parse(readFileSync(file, 'utf8'));
  const repeats = evidence.request_contract?.repeats;
  if (typeof repeats !== 'number') {
    console.error(`${name}: request_contract.repeats is missing; cannot derive full-run unanimity`);
    problems += 1;
    continue;
  }

  let rewritten = 0;
  let disagreements = 0;

  for (const result of evidence.results) {
    const tally = tallyRuns(result.runs, repeats);

    // The counts already in the file must survive the recomputation untouched.
    for (const [field, recomputed] of [
      ['valid_runs', tally.valid_runs],
      ['invalid_runs', tally.invalid_runs],
      ['preserved_votes', tally.preserved_votes],
      ['majority_label', tally.majority_label],
    ]) {
      if (field in result && result[field] !== recomputed) {
        console.error(
          `${name} ${result.id}: stored ${field}=${JSON.stringify(result[field])} but runs[] give ${JSON.stringify(recomputed)}`,
        );
        disagreements += 1;
      }
    }

    if (disagreements > 0) continue;

    delete result.unanimous;
    result.requested_runs = tally.requested_runs;
    result.changed_votes = tally.changed_votes;
    result.valid_vote_unanimous = tally.valid_vote_unanimous;
    result.full_run_unanimous = tally.full_run_unanimous;
    rewritten += 1;
  }

  if (disagreements > 0) {
    console.error(`${name}: ${disagreements} disagreement(s); file left unchanged`);
    problems += 1;
    continue;
  }

  const fullUnanimous = evidence.results.filter((r) => r.full_run_unanimous).length;
  const validUnanimous = evidence.results.filter((r) => r.valid_vote_unanimous).length;

  evidence.derived_fields = {
    backfilled_by: 'scripts/backfill-vote-semantics.mjs',
    replaced: 'unanimous (valid-runs-only) -> valid_vote_unanimous + full_run_unanimous',
    note: 'Derived fields only. No request was replayed and no run, hash or timestamp was altered.',
  };

  if (!checkOnly) {
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    changedFiles += 1;
  }

  console.log(
    `${name.padEnd(34)} pairs=${rewritten} validVoteUnanimous=${validUnanimous} fullRunUnanimous=${fullUnanimous}${checkOnly ? '  (check only, not written)' : ''}`,
  );
}

if (problems > 0) process.exit(1);
if (!checkOnly) console.log(`\n${changedFiles} file(s) updated`);
