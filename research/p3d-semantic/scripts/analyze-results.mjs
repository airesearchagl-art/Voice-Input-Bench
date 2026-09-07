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
 * Every accuracy figure is provisional: the labels have not been confirmed by a
 * human. See HUMAN_GOLD_REVIEW.md.
 *
 * Usage: node scripts/analyze-results.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR, rate, writeEvidence } from './lib/evidence.mjs';
import { loadProbes } from './lib/probes.mjs';
import { criticalSignal } from './lib/criticalInfoMirror.mjs';

function readEvidence(name) {
  const file = path.join(EVIDENCE_DIR, name);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Binary scoring over pairs the method actually decided. */
function confusion(rows) {
  const falsePreserved = rows.filter((r) => r.gold === 'changed' && r.predicted === 'preserved');
  const falseChanged = rows.filter((r) => r.gold === 'preserved' && r.predicted === 'changed');
  const correct = rows.filter((r) => r.gold === r.predicted);
  const hard = rows.filter((r) => r.hard_negative);
  const hardAutoChanged = hard.filter((r) => r.predicted === 'changed');

  return {
    decided: rows.length,
    correct: correct.length,
    provisional_accuracy: rate(correct.length, rows.length),
    false_preserved: falsePreserved.length,
    false_preserved_ids: falsePreserved.map((r) => r.id),
    false_changed: falseChanged.length,
    false_changed_ids: falseChanged.map((r) => r.id),
    hard_negative_auto_changed_recall: rate(hardAutoChanged.length, hard.length),
  };
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
  scoring_caveat:
    'All accuracy figures below are provisional accuracy against proposed labels. No human has confirmed the labels; see HUMAN_GOLD_REVIEW.md.',
  ranking_metric:
    'false_preserved (lower is better). Accuracy is reported and is not the basis of any recommendation.',
  metric_definitions: {
    hard_negative_auto_changed_recall:
      'hard negatives the method decided were changed, without a human',
    hard_negative_non_preserved_coverage:
      'hard negatives the method did not call preserved — changed plus review. Not detection.',
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

function scoreLlm(evidence) {
  if (!evidence || evidence.status !== 'OK') {
    return { status: 'NOT_RUN', reason: 'evidence file absent' };
  }

  const rows = evidence.results.map((r) => ({
    id: r.id,
    gold: r.proposed_label,
    hard_negative: r.hard_negative,
    predicted: r.majority_label,
  }));
  const decided = rows.filter((r) => r.predicted !== null);

  const totalRuns = evidence.results.reduce((n, r) => n + r.valid_runs + r.invalid_runs, 0);
  const invalidRuns = evidence.results.reduce((n, r) => n + r.invalid_runs, 0);
  const exactRuns = evidence.results.reduce((n, r) => n + r.exact_contract_runs, 0);
  const unanimous = evidence.results.filter((r) => r.unanimous).length;
  const byteIdentical = evidence.results.filter((r) => r.byte_identical_responses).length;

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
    unscored_pairs: rows.length - decided.length,
    unanimous_pairs: unanimous,
    unanimous_rate: rate(unanimous, evidence.results.length),
    disagreement_pairs: evidence.results.length - unanimous,
    disagreement_rate: rate(evidence.results.length - unanimous, evidence.results.length),
    byte_identical_pairs: byteIdentical,
    byte_identical_rate: rate(byteIdentical, evidence.results.length),
    ...confusion(decided),
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

/**
 * H0 — the agreement-gated rule from the first spike round, kept for comparison.
 * H1 — the canonical task baseline: critical vetoes, the rubric decides changed,
 *      the embedding can only send a disagreement to review.
 * H2 — H1 with the critical signal demoted from veto to review trigger.
 * H3 — the safety policy: nothing is ever automatically preserved.
 */
const HYBRIDS = {
  H0_agreement_gated: (probe, ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) return { decision: 'changed', by: 'critical-veto' };
    if (ctx.llm === null) return { decision: 'review', by: 'llm-unscored' };
    if (ctx.embeddingSays === ctx.llm) return { decision: ctx.llm, by: 'agreement' };
    return { decision: 'review', by: 'disagreement' };
  },
  H1_canonical_baseline: (probe, ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) return { decision: 'changed', by: 'critical-veto' };
    if (ctx.llm === 'changed') return { decision: 'changed', by: 'llm-changed' };
    if (ctx.llm === null || !ctx.unanimous) return { decision: 'review', by: 'llm-uncertain' };
    if (ctx.embeddingSays !== ctx.llm) return { decision: 'review', by: 'embedding-conflict' };
    return { decision: 'preserved', by: 'agreement' };
  },
  H2_critical_review_trigger: (probe, ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) return { decision: 'review', by: 'critical-review' };
    if (ctx.llm === 'changed') return { decision: 'changed', by: 'llm-changed' };
    if (ctx.llm === null || !ctx.unanimous) return { decision: 'review', by: 'llm-uncertain' };
    if (ctx.embeddingSays !== ctx.llm) return { decision: 'review', by: 'embedding-conflict' };
    return { decision: 'preserved', by: 'agreement' };
  },
  H3_no_auto_preserved: (probe, ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) return { decision: 'changed', by: 'critical-veto' };
    if (ctx.llm === 'changed' && ctx.unanimous) return { decision: 'changed', by: 'llm-changed' };
    // Nothing else is decided. `preserved` is never automatic.
    return { decision: 'review', by: 'no-auto-preserved' };
  },
};

function scoreHybrid(rows) {
  const automatic = rows.filter((r) => r.decision !== 'review');
  const review = rows.filter((r) => r.decision === 'review');
  const decided = automatic.map((r) => ({ ...r, predicted: r.decision }));
  const hard = rows.filter((r) => r.hard_negative);
  const hardNotPreserved = hard.filter((r) => r.decision !== 'preserved');

  return {
    auto_changed: rows.filter((r) => r.decision === 'changed').length,
    auto_preserved: rows.filter((r) => r.decision === 'preserved').length,
    review_count: review.length,
    review_rate: rate(review.length, rows.length),
    review_ids: review.map((r) => r.id),
    automatic_coverage: rate(automatic.length, rows.length),
    decided_by: rows.reduce((counts, r) => ({ ...counts, [r.by]: (counts[r.by] ?? 0) + 1 }), {}),
    ...confusion(decided),
    hard_negative_non_preserved_coverage: rate(hardNotPreserved.length, hard.length),
    hard_negative_called_preserved_ids: hard
      .filter((r) => r.decision === 'preserved')
      .map((r) => r.id),
  };
}

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
    const llmById = new Map(pairing.llm.results.map((r) => [r.id, r]));
    for (const [name, rule] of Object.entries(HYBRIDS)) {
      for (const threshold of [0.85, 0.9, 0.95]) {
        const rows = probes.map((probe) => {
          const cosine = embeddingById.get(probe.id)[pairing.cosineKey];
          const llmResult = llmById.get(probe.id);
          const ctx = {
            critical: criticalById.get(probe.id),
            embeddingSays: cosine >= threshold ? 'preserved' : 'changed',
            llm: llmResult.majority_label,
            unanimous: llmResult.unanimous,
          };
          const outcome = rule(probe, ctx);
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
    rules: {
      H0_agreement_gated: 'critical veto; else embedding and rubric must agree; else review',
      H1_canonical_baseline:
        'critical veto; else rubric changed wins; else rubric uncertain -> review; else embedding conflict -> review; else preserved',
      H2_critical_review_trigger: 'as H1 but a critical mismatch routes to review instead of vetoing',
      H3_no_auto_preserved: 'critical veto or unanimous rubric changed -> changed; everything else -> review',
    },
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
console.log('all accuracy below is provisional against proposed labels\n');

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
    `llm ${variant.padEnd(8)} acc=${data.provisional_accuracy} FP=${data.false_preserved}${JSON.stringify(data.false_preserved_ids)} FC=${data.false_changed} autoChangedRecall=${data.hard_negative_auto_changed_recall} unanimous=${data.unanimous_rate} schemaValid=${data.parseable_schema_valid_rate} exactContract=${data.exact_output_contract_rate}`,
  );
}

if (summary.hybrid.status === 'OK') {
  console.log('');
  for (const [name, data] of Object.entries(summary.hybrid.variants)) {
    console.log(
      `${name.padEnd(38)} FP=${data.false_preserved} FC=${data.false_changed} autoChanged=${data.auto_changed} autoPreserved=${data.auto_preserved} review=${data.review_rate} coverage=${data.automatic_coverage} hnAutoChanged=${data.hard_negative_auto_changed_recall} hnNonPreserved=${data.hard_negative_non_preserved_coverage}`,
    );
  }
}

console.log(`\nsummary -> ${file}`);
