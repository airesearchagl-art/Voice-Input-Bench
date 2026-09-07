import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_DIR } from './evidence.mjs';
import { HYBRIDS, confusion, hardNegativeMetrics, scoreHybrid } from './scoring.mjs';
import { tallyRuns } from './voteSemantics.mjs';

/**
 * Two ways a tri-state can flatter itself, both fixed in R1.1 and both pinned
 * here.
 *
 * The first is a denominator that shrinks: if hard-negative recall is computed
 * over the rows a rule chose to answer, then routing a hard negative to a human
 * removes it from the measurement instead of counting against it, and a rule
 * that reviews almost everything scores almost perfectly.
 *
 * The second is unanimity computed over the runs that happened to parse: two
 * agreeing runs and one unparseable reply is not three agreeing runs, and an
 * automated `changed` must not rest on the difference.
 */

// --- helpers ---------------------------------------------------------------

/** A corpus of 13 hard negatives plus 15 ordinary pairs, decisions supplied. */
function corpusOf(hardDecisions, otherDecisions = []) {
  const rows = hardDecisions.map((decision, index) => ({
    id: `h${index + 1}`,
    gold: 'changed',
    hard_negative: true,
    decision,
    by: 'test',
  }));
  otherDecisions.forEach((decision, index) => {
    rows.push({
      id: `n${index + 1}`,
      gold: 'preserved',
      hard_negative: false,
      decision,
      by: 'test',
    });
  });
  return rows;
}

const NO_CRITICAL = { applicable: false, mismatch: false };
const CRITICAL_MISMATCH = { applicable: true, mismatch: true };

function runsOf(...labels) {
  // `null` is an unparseable reply: no verdict was recovered.
  return labels.map((label, index) =>
    label === null
      ? {
          attempt: index + 1,
          parseable_schema_valid: false,
          exact_output_contract_valid: false,
          verdict: null,
        }
      : {
          attempt: index + 1,
          parseable_schema_valid: true,
          exact_output_contract_valid: true,
          verdict: { meaning_preserved: label === 'preserved' },
        },
  );
}

// --- RF-1 ------------------------------------------------------------------

describe('hard-negative metrics use the whole corpus as the denominator', () => {
  it('a rule that reviews every hard negative detects none of them', () => {
    // The failure this pins: with a denominator of "rows the rule answered",
    // this rule answered no hard negatives and scored 100%.
    const rows = corpusOf(Array(13).fill('review'));
    const metrics = hardNegativeMetrics(rows);

    expect(metrics.hard_negative_total).toBe(13);
    expect(metrics.hard_negative_auto_changed_recall).toBe('0.0%');
    expect(metrics.hard_negative_non_preserved_coverage).toBe('100.0%');
    expect(metrics.hard_negative_review_count).toBe(13);
    expect(metrics.hard_negative_auto_changed_count).toBe(0);
  });

  it('twelve caught and one reviewed is 92.3% detected and 100% covered', () => {
    const rows = corpusOf([...Array(12).fill('changed'), 'review']);
    const metrics = hardNegativeMetrics(rows);

    expect(metrics.hard_negative_total).toBe(13);
    expect(metrics.hard_negative_auto_changed_count).toBe(12);
    expect(metrics.hard_negative_review_count).toBe(1);
    expect(metrics.hard_negative_auto_changed_recall).toBe('92.3%');
    expect(metrics.hard_negative_non_preserved_coverage).toBe('100.0%');
  });

  it('the denominator does not move as more pairs are reviewed', () => {
    const denominators = [];
    const recalls = [];
    for (let reviewed = 0; reviewed <= 13; reviewed += 1) {
      const rows = corpusOf([
        ...Array(13 - reviewed).fill('changed'),
        ...Array(reviewed).fill('review'),
      ]);
      const metrics = hardNegativeMetrics(rows);
      denominators.push(metrics.hard_negative_total);
      recalls.push(metrics.hard_negative_auto_changed_count);
    }

    expect(new Set(denominators)).toEqual(new Set([13]));
    // Reviewing more must lower detection monotonically, never raise it.
    expect(recalls).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('an auto-preserved hard negative costs coverage as well as recall', () => {
    const rows = corpusOf([...Array(11).fill('changed'), 'review', 'preserved']);
    const metrics = hardNegativeMetrics(rows);

    expect(metrics.hard_negative_auto_changed_recall).toBe('84.6%');
    expect(metrics.hard_negative_non_preserved_coverage).toBe('92.3%');
    expect(metrics.hard_negative_called_preserved_ids).toEqual(['h13']);
  });

  it('confusion() carries no hard-negative metric at all', () => {
    // It only ever sees the automatic rows, so any hard-negative number it
    // produced would have the shrinking denominator built in.
    const keys = Object.keys(
      confusion([{ id: 'a', gold: 'changed', predicted: 'changed', hard_negative: true }]),
    );
    expect(keys.some((key) => key.startsWith('hard_negative'))).toBe(false);
  });

  it('scoreHybrid divides by every hard negative, not the ones it answered', () => {
    const rows = corpusOf(
      [...Array(12).fill('changed'), 'review'],
      ['preserved', 'preserved', 'review'],
    );
    const scored = scoreHybrid(rows);

    expect(scored.decided).toBe(14); // 12 hard + 2 ordinary
    expect(scored.hard_negative_total).toBe(13); // not 12
    expect(scored.hard_negative_auto_changed_recall).toBe('92.3%');
  });
});

describe('the published evidence uses the corpus denominator', () => {
  const summary = JSON.parse(
    readFileSync(path.join(EVIDENCE_DIR, 'analysis-summary.json'), 'utf8'),
  );

  it('every hybrid variant divides by the same 13 hard negatives', () => {
    const variants = Object.entries(summary.hybrid.variants);
    expect(variants.length).toBeGreaterThan(0);

    for (const [name, data] of variants) {
      expect(data.hard_negative_total, name).toBe(13);
      expect(
        data.hard_negative_auto_changed_count +
          data.hard_negative_review_count +
          data.hard_negative_auto_preserved_count,
        name,
      ).toBe(13);
    }
  });

  it('a rule that reviews hard negatives no longer reports perfect detection', () => {
    // H3 raw reviews one of the thirteen. Before the fix it read 100.0%.
    const h3raw = summary.hybrid.variants['H3_no_auto_preserved__raw__t0.9'];
    expect(h3raw.hard_negative_review_count).toBeGreaterThan(0);
    expect(h3raw.hard_negative_auto_changed_recall).not.toBe('100.0%');
    expect(h3raw.hard_negative_auto_changed_recall).toBe('92.3%');
    // It still routed every one of them away from `preserved`.
    expect(h3raw.hard_negative_non_preserved_coverage).toBe('100.0%');
  });

  it('detection is never reported above coverage', () => {
    // Coverage counts everything detection counts, plus review. If the
    // denominators ever diverge again, this inverts.
    for (const [name, data] of Object.entries(summary.hybrid.variants)) {
      const detected = Number.parseFloat(data.hard_negative_auto_changed_recall);
      const covered = Number.parseFloat(data.hard_negative_non_preserved_coverage);
      expect(detected, name).toBeLessThanOrEqual(covered);
    }
  });
});

// --- RF-2 ------------------------------------------------------------------

describe('unanimity is recorded at two levels', () => {
  it('A — three valid runs that agree are unanimous both ways', () => {
    const tally = tallyRuns(runsOf('changed', 'changed', 'changed'), 3);

    expect(tally.valid_runs).toBe(3);
    expect(tally.invalid_runs).toBe(0);
    expect(tally.valid_vote_unanimous).toBe(true);
    expect(tally.full_run_unanimous).toBe(true);
    expect(tally.majority_label).toBe('changed');
  });

  it('B — two agreeing runs and one invalid is not full-run unanimous', () => {
    const tally = tallyRuns(runsOf('changed', 'changed', null), 3);

    expect(tally.valid_runs).toBe(2);
    expect(tally.invalid_runs).toBe(1);
    expect(tally.valid_vote_unanimous).toBe(true);
    expect(tally.full_run_unanimous).toBe(false);
    // The majority is still well defined; it is simply not enough on its own.
    expect(tally.majority_label).toBe('changed');
  });

  it('C — two preserved runs and one invalid is not full-run unanimous', () => {
    const tally = tallyRuns(runsOf('preserved', 'preserved', null), 3);

    expect(tally.valid_vote_unanimous).toBe(true);
    expect(tally.full_run_unanimous).toBe(false);
    expect(tally.majority_label).toBe('preserved');
  });

  it('D — valid runs that disagree are unanimous at neither level', () => {
    const tally = tallyRuns(runsOf('changed', 'preserved', 'changed'), 3);

    expect(tally.valid_vote_unanimous).toBe(false);
    expect(tally.full_run_unanimous).toBe(false);
    expect(tally.majority_label).toBe('changed');
  });

  it('a run that never happened is missing evidence too', () => {
    // Two agreeing runs when three were asked for. Nothing failed to parse, and
    // it is still not the evidence a full-run flag claims.
    const tally = tallyRuns(runsOf('changed', 'changed'), 3);
    expect(tally.valid_vote_unanimous).toBe(true);
    expect(tally.full_run_unanimous).toBe(false);
  });

  it('every run invalid decides nothing', () => {
    const tally = tallyRuns(runsOf(null, null, null), 3);
    expect(tally.valid_vote_unanimous).toBe(false);
    expect(tally.full_run_unanimous).toBe(false);
    expect(tally.majority_label).toBeNull();
  });

  it('a fenced but parseable reply is a valid run', () => {
    // `exact_output_contract_valid` records format compliance and must never
    // invalidate a run — that would discard answers the model got right.
    const runs = runsOf('changed', 'changed', 'changed');
    runs[1].exact_output_contract_valid = false;
    const tally = tallyRuns(runs, 3);

    expect(tally.valid_runs).toBe(3);
    expect(tally.invalid_runs).toBe(0);
    expect(tally.full_run_unanimous).toBe(true);
  });
});

describe('hybrid routing rests on full-run unanimity', () => {
  const embeddingAgrees = (label) => label;

  function ctxFor({ runs, critical = NO_CRITICAL, repeats = 3, embeddingSays = null }) {
    const tally = tallyRuns(runs, repeats);
    return {
      critical,
      embeddingSays: embeddingSays ?? embeddingAgrees(tally.majority_label),
      majorityLabel: tally.majority_label,
      fullRunUnanimous: tally.full_run_unanimous,
      validVoteUnanimous: tally.valid_vote_unanimous,
    };
  }

  it('B — an invalid run sends H1, H2 and H3 to review', () => {
    const ctx = ctxFor({ runs: runsOf('changed', 'changed', null) });

    expect(HYBRIDS.H1_canonical_baseline(ctx).decision).toBe('review');
    expect(HYBRIDS.H2_critical_review_trigger(ctx).decision).toBe('review');
    expect(HYBRIDS.H3_no_auto_preserved(ctx).decision).toBe('review');
  });

  it('B — a deterministic critical mismatch still decides for H1 and H3', () => {
    // The critical signal is computed from the texts, not from the model, so an
    // unparseable reply does not weaken it.
    const ctx = ctxFor({
      runs: runsOf('changed', 'changed', null),
      critical: CRITICAL_MISMATCH,
    });

    expect(HYBRIDS.H1_canonical_baseline(ctx).decision).toBe('changed');
    expect(HYBRIDS.H3_no_auto_preserved(ctx).decision).toBe('changed');
    // H2 is exactly the rule that demotes the veto to a review trigger.
    expect(HYBRIDS.H2_critical_review_trigger(ctx).decision).toBe('review');
  });

  it('C — two preserved runs and one invalid are never auto-preserved', () => {
    const ctx = ctxFor({ runs: runsOf('preserved', 'preserved', null) });

    expect(HYBRIDS.H1_canonical_baseline(ctx).decision).toBe('review');
    expect(HYBRIDS.H2_critical_review_trigger(ctx).decision).toBe('review');
    expect(HYBRIDS.H3_no_auto_preserved(ctx).decision).toBe('review');
  });

  it('D — a split vote goes to review under all three candidate rules', () => {
    const ctx = ctxFor({ runs: runsOf('changed', 'preserved', 'changed') });

    expect(HYBRIDS.H1_canonical_baseline(ctx).decision).toBe('review');
    expect(HYBRIDS.H2_critical_review_trigger(ctx).decision).toBe('review');
    expect(HYBRIDS.H3_no_auto_preserved(ctx).decision).toBe('review');
  });

  it('A — three agreeing changed runs decide changed', () => {
    const ctx = ctxFor({ runs: runsOf('changed', 'changed', 'changed') });

    expect(HYBRIDS.H1_canonical_baseline(ctx).decision).toBe('changed');
    expect(HYBRIDS.H2_critical_review_trigger(ctx).decision).toBe('changed');
    expect(HYBRIDS.H3_no_auto_preserved(ctx).decision).toBe('changed');
  });

  it('H3 never produces an automatic preserved', () => {
    for (const runs of [
      runsOf('preserved', 'preserved', 'preserved'),
      runsOf('preserved', 'preserved', null),
      runsOf('preserved', 'changed', 'preserved'),
    ]) {
      for (const embeddingSays of ['preserved', 'changed']) {
        const ctx = ctxFor({ runs, embeddingSays });
        expect(HYBRIDS.H3_no_auto_preserved(ctx).decision).not.toBe('preserved');
      }
    }
  });

  it('H1 auto-preserves only on three agreeing runs and an agreeing embedding', () => {
    const unanimous = ctxFor({
      runs: runsOf('preserved', 'preserved', 'preserved'),
      embeddingSays: 'preserved',
    });
    expect(HYBRIDS.H1_canonical_baseline(unanimous).decision).toBe('preserved');

    const embeddingDisagrees = ctxFor({
      runs: runsOf('preserved', 'preserved', 'preserved'),
      embeddingSays: 'changed',
    });
    expect(HYBRIDS.H1_canonical_baseline(embeddingDisagrees).decision).toBe('review');
  });
});

describe('the published LLM evidence separates the two unanimity levels', () => {
  const summary = JSON.parse(
    readFileSync(path.join(EVIDENCE_DIR, 'analysis-summary.json'), 'utf8'),
  );

  it('reports both rates and never a single "unanimous"', () => {
    for (const [variant, data] of Object.entries(summary.llm_rubric)) {
      if (data.status !== 'OK') continue;
      expect(data.valid_vote_unanimous_rate, variant).toBeDefined();
      expect(data.full_run_unanimous_rate, variant).toBeDefined();
      expect(data.unanimous_rate, variant).toBeUndefined();
      // Full-run unanimity is the stricter of the two and can never exceed it.
      expect(data.full_run_unanimous_pairs, variant).toBeLessThanOrEqual(
        data.valid_vote_unanimous_pairs,
      );
    }
  });

  it('the raw run is 100% valid-vote unanimous and less than that full-run', () => {
    // This is the claim R1's report made as a flat "unanimous 100%". Three of
    // the twenty-eight pairs had a reply that could not be parsed.
    const raw = summary.llm_rubric.raw;
    expect(raw.valid_vote_unanimous_rate).toBe('100.0%');
    expect(raw.full_run_unanimous_rate).not.toBe('100.0%');
    expect(raw.pairs_with_an_invalid_run).toBeGreaterThan(0);
    expect(raw.pairs_with_an_invalid_run).toBe(
      raw.valid_vote_unanimous_pairs - raw.full_run_unanimous_pairs,
    );
  });

  it('the stored evidence carries both flags per pair', () => {
    for (const name of ['llm-rubric-results.raw.json', 'llm-rubric-results.surface.json']) {
      const evidence = JSON.parse(readFileSync(path.join(EVIDENCE_DIR, name), 'utf8'));
      for (const result of evidence.results) {
        expect(result.unanimous, `${name} ${result.id}`).toBeUndefined();
        expect(typeof result.valid_vote_unanimous, `${name} ${result.id}`).toBe('boolean');
        expect(typeof result.full_run_unanimous, `${name} ${result.id}`).toBe('boolean');
        // Re-derived from the runs still in the file, so the flags cannot drift
        // from the evidence they claim to summarise.
        const tally = tallyRuns(result.runs, evidence.request_contract.repeats);
        expect(tally.valid_vote_unanimous, `${name} ${result.id}`).toBe(
          result.valid_vote_unanimous,
        );
        expect(tally.full_run_unanimous, `${name} ${result.id}`).toBe(result.full_run_unanimous);
      }
    }
  });
});
