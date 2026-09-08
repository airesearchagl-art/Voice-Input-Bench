#!/usr/bin/env node
/**
 * Score the methods against the proposed labels.
 *
 * The ranking metric is **false preserved**, not accuracy. A method that calls a
 * reversed instruction "preserved" has told an engineer the transcript is fine
 * when it says the opposite thing; a method that flags a correct transcript has
 * cost someone a minute. Those are not two sides of one number.
 *
 * Two things are reported separately throughout, because collapsing them would
 * flatter every tri-state:
 *
 *   - **auto-changed recall** — the method decided, by itself, that a hard
 *     negative had changed.
 *   - **non-preserved routing** — the method did not tell anyone it was fine.
 *     `review` counts here and only here.
 *
 * Sending something to a human is not detection. It is the absence of a wrong
 * answer, which is worth measuring and is worth measuring under its own name.
 *
 * Both are divided by **every hard negative in the corpus**, never by the subset
 * a rule chose to answer. A denominator that shrinks as a rule reviews more
 * would let "I did not answer" raise a recall score.
 *
 * Vote semantics are re-derived here from the stored `runs[]` rather than read
 * from a stored flag, so a change to what counts as agreement is a change to one
 * function and not to a set of files that were written months apart.
 *
 * How an accuracy figure may be described is derived from `gold_provenance`,
 * never written by hand — see `lib/goldStatus.mjs`. While the labels were
 * proposals, every figure said so. They were reviewed and approved unchanged on
 * 2026-09-08, so the same figures are now accuracy against human-reviewed
 * labels. Rounds R0, R1 and R1.1 were measured before that review and keep their
 * provisional wording.
 *
 * Usage: node scripts/analyze-results.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR, rate, writeEvidence } from './lib/evidence.mjs';
import { loadProbes } from './lib/probes.mjs';
import { criticalSignal } from './lib/criticalInfoMirror.mjs';
import { goldStatus } from './lib/goldStatus.mjs';
import {
  HYBRIDS,
  HYBRID_RULE_DESCRIPTIONS,
  confusion,
  hardNegativeMetrics,
  scoreHybrid,
} from './lib/scoring.mjs';
import { tallyRuns } from './lib/voteSemantics.mjs';

function readEvidence(name) {
  const file = path.join(EVIDENCE_DIR, name);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

const { probes, sha256, corpus } = loadProbes();

const embedding = readEvidence('embedding-results.json');
const llmRaw = readEvidence('llm-rubric-results.raw.json');
const llmSurface = readEvidence('llm-rubric-results.surface.json');

const summary = {
  analysed_at: new Date().toISOString(),
  probes_sha256: sha256,
  probe_count: probes.length,
  gold_provenance: corpus.gold_provenance,
  gold_status: goldStatus(corpus.gold_provenance),
  scoring_caveat: goldStatus(corpus.gold_provenance).caveat,
  ranking_metric:
    'false_preserved (lower is better). Accuracy is reported and is not the basis of any recommendation.',
  metric_definitions: {
    hard_negative_auto_changed_recall:
      'hard negatives the method decided were changed, without a human, over EVERY hard negative in the corpus. Review does not count. This is detection.',
    hard_negative_non_preserved_coverage:
      'hard negatives the method did not call preserved — changed plus review — over EVERY hard negative in the corpus. Not detection.',
    hard_negative_total: 'the shared denominator: hard negatives in the corpus, always the same number',
    valid_vote_unanimous:
      'among the runs that produced a verdict, every verdict agreed. Says nothing about how many runs that was.',
    full_run_unanimous:
      'every requested run produced a verdict and every verdict agreed. The only unanimity an automated decision rests on.',
    parseable_schema_valid:
      'a verdict object was recoverable from the reply. This is what invalid means here.',
    exact_output_contract_valid:
      'the reply was the object and nothing else. Recorded separately and never used to invalidate a run.',
  },
};

// ---------------------------------------------------------------------------
// A. Embedding
// ---------------------------------------------------------------------------

if (!embedding || embedding.status !== 'OK') {
  summary.embedding = {
    status: embedding?.status ?? 'NOT_RUN',
    reason: embedding?.reason ?? 'evidence/embedding-results.json is absent',
  };
} else {
  const variants = {};
  for (const variant of ['raw', 'surface']) {
    const key = variant === 'raw' ? 'cosine_raw' : 'cosine_surface';
    const preserved = embedding.results.filter((r) => r.proposed_label === 'preserved');
    const changed = embedding.results.filter((r) => r.proposed_label === 'changed');
    const hard = embedding.results.filter((r) => r.hard_negative);

    const minPreserved = Math.min(...preserved.map((r) => r[key]));
    const maxChanged = Math.max(...changed.map((r) => r[key]));

    const sweep = [];
    for (let t = 0.7; t <= 0.995; t += 0.005) {
      const threshold = Number(t.toFixed(3));
      const rows = embedding.results.map((r) => ({
        id: r.id,
        gold: r.proposed_label,
        hard_negative: r.hard_negative,
        predicted: r[key] >= threshold ? 'preserved' : 'changed',
      }));
      const c = confusion(rows);
      sweep.push({
        threshold,
        false_preserved: c.false_preserved,
        false_changed: c.false_changed,
        correct: c.correct,
      });
    }

    const zeroFalsePreserved = sweep
      .filter((s) => s.false_preserved === 0)
      .sort((a, b) => a.false_changed - b.false_changed)[0] ?? null;

    variants[variant] = {
      min_preserved_similarity: Number(minPreserved.toFixed(4)),
      min_preserved_id: preserved.find((r) => r[key] === minPreserved)?.id,
      max_changed_similarity: Number(maxChanged.toFixed(4)),
      max_changed_id: changed.find((r) => r[key] === maxChanged)?.id,
      separable: minPreserved > maxChanged,
      hard_negative_similarity: hard
        .map((r) => ({ id: r.id, reason: r.proposed_reason_code, cosine: Number(r[key].toFixed(4)) }))
        .sort((a, b) => b.cosine - a.cosine),
      threshold_with_zero_false_preserved: zeroFalsePreserved,
      best_accuracy_threshold: sweep
        .slice()
        .sort((a, b) => b.correct - a.correct || a.false_preserved - b.false_preserved)[0],
    };
  }

  summary.embedding = {
    status: 'OK',
    model: embedding.model?.id ?? embedding.model,
    runtime: embedding.runtime,
    endpoint: embedding.endpoint,
    latency_ms: embedding.latency_ms,
    variants,
    verdict: variants.raw.separable || variants.surface.separable
      ? 'a threshold separates preserved from changed on this corpus'
      : 'no threshold separates preserved from changed on this corpus',
  };
}

// ---------------------------------------------------------------------------
// B. LLM rubric, per input variant
// ---------------------------------------------------------------------------

/** Re-derived from the stored runs, so no analysis depends on a stored flag. */
function tallyByIdFor(evidence) {
  const repeats = evidence.request_contract?.repeats ?? null;
  if (repeats === null) {
    throw new Error(
      `${evidence.input_variant} evidence has no request_contract.repeats; full-run unanimity cannot be derived`,
    );
  }
  return new Map(evidence.results.map((r) => [r.id, tallyRuns(r.runs, repeats)]));
}

function scoreLlm(evidence) {
  if (!evidence || evidence.status !== 'OK') {
    return { status: 'NOT_RUN', reason: 'evidence file absent' };
  }

  const tallyById = tallyByIdFor(evidence);

  const rows = evidence.results.map((r) => {
    const tally = tallyById.get(r.id);
    return {
      id: r.id,
      gold: r.proposed_label,
      hard_negative: r.hard_negative,
      predicted: tally.majority_label,
      // A pair with no verdict at all is not an automatic answer; for the
      // hard-negative metrics it sits where a review would.
      decision: tally.majority_label ?? 'review',
    };
  });
  const decided = rows.filter((r) => r.predicted !== null);

  const tallies = [...tallyById.values()];
  const totalRuns = tallies.reduce((n, t) => n + t.completed_runs, 0);
  const invalidRuns = tallies.reduce((n, t) => n + t.invalid_runs, 0);
  const exactRuns = evidence.results.reduce((n, r) => n + r.exact_contract_runs, 0);
  const validVoteUnanimous = tallies.filter((t) => t.valid_vote_unanimous).length;
  const fullRunUnanimous = tallies.filter((t) => t.full_run_unanimous).length;
  const byteIdentical = evidence.results.filter((r) => r.byte_identical_responses).length;
  const pairsWithInvalid = tallies.filter((t) => t.invalid_runs > 0).length;

  return {
    status: 'OK',
    input_variant: evidence.input_variant,
    model: evidence.model?.id ?? evidence.model,
    runtime: evidence.runtime,
    request_contract: evidence.request_contract,
    prompt_sha256: evidence.prompt_sha256,
    latency_ms: evidence.latency_ms,
    total_runs: totalRuns,
    // Two different questions about the same replies.
    parseable_schema_valid_rate: rate(totalRuns - invalidRuns, totalRuns),
    exact_output_contract_rate: rate(exactRuns, totalRuns),
    invalid_runs: invalidRuns,
    pairs_with_an_invalid_run: pairsWithInvalid,
    pairs_with_an_invalid_run_ids: [...tallyById.entries()]
      .filter(([, t]) => t.invalid_runs > 0)
      .map(([id]) => id),
    unscored_pairs: rows.length - decided.length,
    // Two unanimity levels, never one. The first ignores how many runs there
    // were; only the second may carry an automated decision.
    valid_vote_unanimous_pairs: validVoteUnanimous,
    valid_vote_unanimous_rate: rate(validVoteUnanimous, evidence.results.length),
    full_run_unanimous_pairs: fullRunUnanimous,
    full_run_unanimous_rate: rate(fullRunUnanimous, evidence.results.length),
    valid_vote_split_pairs: evidence.results.length - validVoteUnanimous,
    byte_identical_pairs: byteIdentical,
    byte_identical_rate: rate(byteIdentical, evidence.results.length),
    ...confusion(decided),
    ...hardNegativeMetrics(rows),
  };
}

summary.llm_rubric = { raw: scoreLlm(llmRaw), surface: scoreLlm(llmSurface) };

// ---------------------------------------------------------------------------
// The deterministic guard
// ---------------------------------------------------------------------------

const criticalById = new Map(
  probes.map((probe) => [probe.id, criticalSignal(probe.reference, probe.hypothesis)]),
);

summary.critical_info_signal = {
  applicable_pairs: [...criticalById.values()].filter((s) => s.applicable).length,
  mismatch_pairs: [...criticalById.values()].filter((s) => s.applicable && s.mismatch).length,
  mismatch_on_preserved: probes
    .filter((p) => criticalById.get(p.id).applicable && criticalById.get(p.id).mismatch && p.gold.label === 'preserved')
    .map((p) => p.id),
  mismatch_on_changed: probes
    .filter((p) => criticalById.get(p.id).applicable && criticalById.get(p.id).mismatch && p.gold.label === 'changed')
    .map((p) => p.id),
  not_applicable: probes.filter((p) => !criticalById.get(p.id).applicable).map((p) => p.id),
};

// ---------------------------------------------------------------------------
// C. Hybrid variants
// ---------------------------------------------------------------------------

if (summary.embedding.status === 'OK' && summary.llm_rubric.raw.status === 'OK') {
  const embeddingById = new Map(embedding.results.map((r) => [r.id, r]));
  const hybrid = {};

  // raw/raw and surface/surface, so a variant is compared against itself rather
  // than against a mixture.
  const pairings = [
    { name: 'raw', llm: llmRaw, cosineKey: 'cosine_raw' },
    { name: 'surface', llm: llmSurface, cosineKey: 'cosine_surface' },
  ].filter((pairing) => pairing.llm && pairing.llm.status === 'OK');

  for (const pairing of pairings) {
    const tallyById = tallyByIdFor(pairing.llm);
    for (const [name, rule] of Object.entries(HYBRIDS)) {
      for (const threshold of [0.85, 0.9, 0.95]) {
        const rows = probes.map((probe) => {
          const cosine = embeddingById.get(probe.id)[pairing.cosineKey];
          const tally = tallyById.get(probe.id);
          const ctx = {
            critical: criticalById.get(probe.id),
            embeddingSays: cosine >= threshold ? 'preserved' : 'changed',
            majorityLabel: tally.majority_label,
            fullRunUnanimous: tally.full_run_unanimous,
            validVoteUnanimous: tally.valid_vote_unanimous,
          };
          const outcome = rule(ctx);
          return {
            id: probe.id,
            gold: probe.gold.label,
            hard_negative: probe.hard_negative,
            decision: outcome.decision,
            by: outcome.by,
          };
        });
        hybrid[`${name}__${pairing.name}__t${threshold}`] = scoreHybrid(rows);
      }
    }
  }

  summary.hybrid = {
    status: 'OK',
    rules: HYBRID_RULE_DESCRIPTIONS,
    unanimity_used_for_automation: 'full_run_unanimous',
    variants: hybrid,
  };
} else {
  summary.hybrid = { status: 'NOT_RUN', reason: 'needs embedding and at least the raw LLM evidence' };
}

const file = writeEvidence('analysis-summary.json', summary);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`probes ${probes.length} (sha ${sha256.slice(0, 16)}…)  labels: ${corpus.gold_provenance.authoring} / human review ${corpus.gold_provenance.human_review_status}`);
console.log(`all accuracy below is ${summary.gold_status.accuracy_label}\n`);

if (summary.embedding.status === 'OK') {
  for (const [variant, data] of Object.entries(summary.embedding.variants)) {
    console.log(
      `embedding ${variant.padEnd(8)} minPreserved=${data.min_preserved_similarity}(${data.min_preserved_id}) maxChanged=${data.max_changed_similarity}(${data.max_changed_id}) separable=${data.separable}`,
    );
  }
}

for (const [variant, data] of Object.entries(summary.llm_rubric)) {
  if (data.status !== 'OK') {
    console.log(`llm ${variant.padEnd(8)} NOT RUN`);
    continue;
  }
  console.log(
    `llm ${variant.padEnd(8)} acc=${data.provisional_accuracy} FP=${data.false_preserved}${JSON.stringify(data.false_preserved_ids)} FC=${data.false_changed} autoChangedRecall=${data.hard_negative_auto_changed_recall} validVoteUnanimous=${data.valid_vote_unanimous_rate} fullRunUnanimous=${data.full_run_unanimous_rate} schemaValid=${data.parseable_schema_valid_rate} exactContract=${data.exact_output_contract_rate}`,
  );
}

if (summary.hybrid.status === 'OK') {
  console.log('');
  for (const [name, data] of Object.entries(summary.hybrid.variants)) {
    console.log(
      `${name.padEnd(38)} FP=${data.false_preserved} FC=${data.false_changed} autoChanged=${data.auto_changed} autoPreserved=${data.auto_preserved} review=${data.review_rate} coverage=${data.automatic_coverage} hnAutoChanged=${data.hard_negative_auto_changed_recall}(${data.hard_negative_auto_changed_count}/${data.hard_negative_total}) hnNonPreserved=${data.hard_negative_non_preserved_coverage}`,
    );
  }
}

console.log(`\nsummary -> ${file}`);
