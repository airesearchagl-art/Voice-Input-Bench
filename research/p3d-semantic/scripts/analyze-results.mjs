#!/usr/bin/env node
/**
 * Score the three methods against the frozen gold labels.
 *
 * The ranking metric is **false preserved**, not accuracy. A method that calls a
 * reversed instruction "preserved" has told an engineer the transcript is fine
 * when it says the opposite thing; a method that flags a correct transcript has
 * cost someone a minute. Those are not two sides of one number, and a summary
 * that averages them would hide the only failure that matters.
 *
 * Reads the evidence files written by the two runners, adds the hybrid
 * simulation, and writes `evidence/analysis-summary.json`.
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

function confusion(rows) {
  // `false preserved` is a changed pair called preserved: the transcript is
  // wrong and the method said it was fine.
  const falsePreserved = rows.filter((r) => r.gold === 'changed' && r.predicted === 'preserved');
  const falseChanged = rows.filter((r) => r.gold === 'preserved' && r.predicted === 'changed');
  const correct = rows.filter((r) => r.gold === r.predicted);
  const hardNegatives = rows.filter((r) => r.hard_negative);
  const hardCaught = hardNegatives.filter((r) => r.predicted === 'changed');

  return {
    total: rows.length,
    correct: correct.length,
    accuracy: rate(correct.length, rows.length),
    false_preserved: falsePreserved.length,
    false_preserved_rate: rate(falsePreserved.length, rows.filter((r) => r.gold === 'changed').length),
    false_preserved_ids: falsePreserved.map((r) => r.id),
    false_changed: falseChanged.length,
    false_changed_rate: rate(falseChanged.length, rows.filter((r) => r.gold === 'preserved').length),
    false_changed_ids: falseChanged.map((r) => r.id),
    hard_negative_recall: rate(hardCaught.length, hardNegatives.length),
    hard_negative_missed_ids: hardNegatives
      .filter((r) => r.predicted !== 'changed')
      .map((r) => r.id),
  };
}

const { probes, sha256 } = loadProbes();
const byId = new Map(probes.map((probe) => [probe.id, probe]));

const embedding = readEvidence('embedding-results.json');
const llm = readEvidence('llm-rubric-results.json');

const summary = {
  analysed_at: new Date().toISOString(),
  probes_sha256: sha256,
  probe_count: probes.length,
  ranking_metric: 'false_preserved (lower is better); accuracy is reported but is not the ranking metric',
};

// ---------------------------------------------------------------------------
// A. Embedding
// ---------------------------------------------------------------------------

if (!embedding || embedding.status !== 'OK') {
  summary.embedding = {
    status: embedding?.status ?? 'NOT_RUN',
    reason: embedding?.reason ?? 'evidence/embedding-results.json is absent',
  };
  console.log('embedding: not available');
} else {
  const variants = {};
  for (const variant of ['raw', 'surface']) {
    const key = variant === 'raw' ? 'cosine_raw' : 'cosine_surface';
    const preserved = embedding.results.filter((r) => r.gold_label === 'preserved');
    const changed = embedding.results.filter((r) => r.gold_label === 'changed');
    const hard = embedding.results.filter((r) => r.hard_negative);

    const minPreserved = Math.min(...preserved.map((r) => r[key]));
    const maxChanged = Math.max(...changed.map((r) => r[key]));

    // A threshold sweep, for analysis only. No production threshold is chosen
    // here: that is a decision about acceptable false-preserved risk, and it
    // belongs to whoever owns the consequence.
    const sweep = [];
    for (let t = 0.70; t <= 0.995; t += 0.005) {
      const threshold = Number(t.toFixed(3));
      const rows = embedding.results.map((r) => ({
        id: r.id,
        gold: r.gold_label,
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

    const zeroFalsePreserved = sweep.filter((s) => s.false_preserved === 0);
    const bestZero = zeroFalsePreserved.sort((a, b) => a.false_changed - b.false_changed)[0] ?? null;

    variants[variant] = {
      min_preserved_similarity: Number(minPreserved.toFixed(4)),
      min_preserved_id: preserved.find((r) => r[key] === minPreserved)?.id,
      max_changed_similarity: Number(maxChanged.toFixed(4)),
      max_changed_id: changed.find((r) => r[key] === maxChanged)?.id,
      separable: minPreserved > maxChanged,
      hard_negative_similarity: hard
        .map((r) => ({ id: r.id, reason: r.gold_reason_code, cosine: Number(r[key].toFixed(4)) }))
        .sort((a, b) => b.cosine - a.cosine),
      threshold_with_zero_false_preserved: bestZero,
      best_accuracy_threshold: sweep
        .slice()
        .sort((a, b) => b.correct - a.correct || a.false_preserved - b.false_preserved)[0],
    };
  }

  summary.embedding = {
    status: 'OK',
    model: embedding.model,
    endpoint: embedding.endpoint,
    latency_ms: embedding.latency_ms,
    variants,
    verdict:
      variants.raw.separable || variants.surface.separable
        ? 'a threshold separates preserved from changed on this corpus'
        : 'no threshold separates preserved from changed on this corpus',
  };
}

// ---------------------------------------------------------------------------
// B. LLM rubric
// ---------------------------------------------------------------------------

if (!llm || llm.status !== 'OK') {
  summary.llm_rubric = {
    status: llm?.status ?? 'NOT_RUN',
    reason: 'evidence/llm-rubric-results.json is absent',
  };
  console.log('llm rubric: not available');
} else {
  const rows = llm.results.map((r) => ({
    id: r.id,
    gold: r.gold_label,
    hard_negative: r.hard_negative,
    // A pair with no valid run is not a prediction. It is counted as `invalid`
    // and left out of the confusion matrix rather than defaulted to preserved.
    predicted: r.majority_label,
  }));
  const scored = rows.filter((r) => r.predicted !== null);

  const totalRuns = llm.results.reduce((n, r) => n + r.valid_runs + r.invalid_runs, 0);
  const invalidRuns = llm.results.reduce((n, r) => n + r.invalid_runs, 0);
  const unanimous = llm.results.filter((r) => r.unanimous).length;

  summary.llm_rubric = {
    status: 'OK',
    model: llm.model,
    endpoint: llm.endpoint,
    api: llm.api,
    temperature: llm.temperature,
    repeats: llm.repeats,
    prompt_sha256: llm.prompt_sha256,
    latency_ms: llm.latency_ms,
    total_runs: totalRuns,
    invalid_json_runs: invalidRuns,
    invalid_json_rate: rate(invalidRuns, totalRuns),
    unscored_pairs: rows.length - scored.length,
    unanimous_pairs: unanimous,
    unanimous_rate: rate(unanimous, llm.results.length),
    disagreement_pairs: llm.results.length - unanimous,
    disagreement_rate: rate(llm.results.length - unanimous, llm.results.length),
    ...confusion(scored),
  };
}

// ---------------------------------------------------------------------------
// C. Hybrid tri-state
// ---------------------------------------------------------------------------

const criticalRows = probes.map((probe) => {
  const signal = criticalSignal(probe.reference, probe.hypothesis);
  return { id: probe.id, gold: probe.gold.label, hard_negative: probe.hard_negative, signal };
});

summary.critical_info_signal = {
  applicable_pairs: criticalRows.filter((r) => r.signal.applicable).length,
  mismatch_pairs: criticalRows.filter((r) => r.signal.applicable && r.signal.mismatch).length,
  // Every pair the veto fires on: it should never fire on a preserved pair, or
  // the veto is itself a source of false alarms.
  mismatch_on_preserved: criticalRows
    .filter((r) => r.signal.applicable && r.signal.mismatch && r.gold === 'preserved')
    .map((r) => r.id),
  mismatch_on_changed: criticalRows
    .filter((r) => r.signal.applicable && r.signal.mismatch && r.gold === 'changed')
    .map((r) => r.id),
  not_applicable: criticalRows.filter((r) => !r.signal.applicable).map((r) => r.id),
};

if (summary.llm_rubric?.status === 'OK' && summary.embedding?.status === 'OK') {
  const embeddingById = new Map(embedding.results.map((r) => [r.id, r]));
  const llmById = new Map(llm.results.map((r) => [r.id, r]));

  /**
   * The rule under test.
   *
   * 1. A critical-info mismatch is a veto: the facts themselves disagree, and
   *    no amount of semantic similarity makes that a preserved transcript.
   * 2. Otherwise, agreement between the two model methods decides.
   * 3. Otherwise `review` — a human looks. That is the cost the tri-state pays
   *    to keep false preserved at zero.
   */
  function hybrid(id, embeddingThreshold) {
    const critical = criticalRows.find((r) => r.id === id).signal;
    if (critical.applicable && critical.mismatch) {
      return { decision: 'changed', by: 'critical-veto' };
    }
    const cosine = embeddingById.get(id).cosine_raw;
    const embeddingSays = cosine >= embeddingThreshold ? 'preserved' : 'changed';
    const llmSays = llmById.get(id).majority_label;
    if (llmSays === null) return { decision: 'review', by: 'llm-unscored' };
    if (embeddingSays === llmSays) return { decision: llmSays, by: 'agreement' };
    return { decision: 'review', by: 'disagreement' };
  }

  const hybridVariants = {};
  for (const threshold of [0.85, 0.9, 0.95]) {
    const rows = probes.map((probe) => {
      const outcome = hybrid(probe.id, threshold);
      return {
        id: probe.id,
        gold: probe.gold.label,
        hard_negative: probe.hard_negative,
        decision: outcome.decision,
        by: outcome.by,
      };
    });

    const automatic = rows.filter((r) => r.decision !== 'review');
    const review = rows.filter((r) => r.decision === 'review');
    const scored = automatic.map((r) => ({ ...r, predicted: r.decision }));
    const hard = rows.filter((r) => r.hard_negative);
    // A hard negative sent to review has not been missed: nobody has been told
    // it is fine.
    const hardNotPreserved = hard.filter((r) => r.decision !== 'preserved');

    hybridVariants[`embedding_threshold_${threshold}`] = {
      automatic_coverage: rate(automatic.length, rows.length),
      review_rate: rate(review.length, rows.length),
      review_ids: review.map((r) => r.id),
      decided_by: {
        critical_veto: rows.filter((r) => r.by === 'critical-veto').length,
        agreement: rows.filter((r) => r.by === 'agreement').length,
        review: review.length,
      },
      ...confusion(scored),
      hard_negative_recall_incl_review: rate(hardNotPreserved.length, hard.length),
    };
  }

  summary.hybrid = {
    status: 'OK',
    rule: 'critical mismatch vetoes to changed; otherwise embedding and LLM must agree; otherwise review',
    variants: hybridVariants,
  };
} else {
  summary.hybrid = { status: 'NOT_RUN', reason: 'needs both embedding and llm evidence' };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const file = writeEvidence('analysis-summary.json', summary);

console.log(`probes            ${probes.length} (sha ${sha256.slice(0, 16)}…)`);
if (summary.embedding.status === 'OK') {
  for (const [variant, data] of Object.entries(summary.embedding.variants)) {
    console.log(
      `embedding ${variant.padEnd(8)} min preserved=${data.min_preserved_similarity} (${data.min_preserved_id})  max changed=${data.max_changed_similarity} (${data.max_changed_id})  separable=${data.separable}`,
    );
  }
}
if (summary.llm_rubric.status === 'OK') {
  const l = summary.llm_rubric;
  console.log(
    `llm rubric        accuracy=${l.accuracy} falsePreserved=${l.false_preserved} ${JSON.stringify(l.false_preserved_ids)} falseChanged=${l.false_changed} unanimous=${l.unanimous_rate} invalidJSON=${l.invalid_json_rate}`,
  );
}
if (summary.hybrid.status === 'OK') {
  for (const [name, data] of Object.entries(summary.hybrid.variants)) {
    console.log(
      `hybrid ${name.padEnd(28)} falsePreserved=${data.false_preserved} falseChanged=${data.false_changed} review=${data.review_rate} coverage=${data.automatic_coverage} hardNegRecall=${data.hard_negative_recall_incl_review}`,
    );
  }
}
console.log(`\nsummary -> ${file}`);
if (byId.size !== probes.length) console.warn('warning: duplicate probe ids');
