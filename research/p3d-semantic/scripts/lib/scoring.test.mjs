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

  it('confusion() reports accuracy without a standing claim in the name', () => {
    // `provisional_accuracy` baked the corpus's review status into a field name,
    // so the name became wrong the moment a human approved the labels. The
    // standing lives in `gold_status` instead, computed from the provenance.
    const scored = confusion([
      { id: 'a', gold: 'changed', predicted: 'changed', hard_negative: false },
      { id: 'b', gold: 'preserved', predicted: 'changed', hard_negative: false },
    ]);
    expect(scored.accuracy).toBe('50.0%');
    expect(scored).not.toHaveProperty('provisional_accuracy');
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

  it('review never counts towards detection in the published numbers', () => {
    // The invariant, not a frozen figure: whenever a rule reviews a hard
    // negative, detection must be short of 100% by exactly that much. Before
    // the fix, reviewing one of thirteen still read 100.0%.
    for (const [name, data] of Object.entries(summary.hybrid.variants)) {
      const expected = `${((data.hard_negative_auto_changed_count / 13) * 100).toFixed(1)}%`;
      expect(data.hard_negative_auto_changed_recall, name).toBe(expected);
      if (data.hard_negative_review_count > 0) {
        expect(data.hard_negative_auto_changed_recall, name).not.toBe('100.0%');
      }
    }
  });

  it('H3 never auto-preserves anything, at any threshold or input', () => {
    const h3 = Object.entries(summary.hybrid.variants).filter(([name]) =>
      name.startsWith('H3_no_auto_preserved'),
    );
    expect(h3.length).toBe(6); // 2 input variants x 3 thresholds
    for (const [name, data] of h3) {
      expect(data.auto_preserved, name).toBe(0);
      expect(data.hard_negative_auto_preserved_count, name).toBe(0);
      expect(data.false_preserved, name).toBe(0);
      expect(data.hard_negative_non_preserved_coverage, name).toBe('100.0%');
    }
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

// --- H4: the critical policy, measured on its own ---------------------------

describe('H4 separates the critical policy from the auto-preserved policy', () => {
  // H3 and H4 differ in one step and nothing else, which is what makes the cost
  // of each critical policy readable rather than bundled with the rest.
  function ctx({ runs = runsOf('changed', 'changed', 'changed'), critical = NO_CRITICAL } = {}) {
    const tally = tallyRuns(runs, 3);
    return {
      critical,
      // H4 reads no embedding. Supplying a hostile value proves it.
      embeddingSays: 'preserved',
      majorityLabel: tally.majority_label,
      fullRunUnanimous: tally.full_run_unanimous,
      validVoteUnanimous: tally.valid_vote_unanimous,
    };
  }

  it('routes a critical mismatch to review where H3 decides changed', () => {
    const mismatch = ctx({ critical: CRITICAL_MISMATCH });
    expect(HYBRIDS.H3_no_auto_preserved(mismatch).decision).toBe('changed');
    expect(HYBRIDS.H4_no_auto_preserved_critical_review(mismatch).decision).toBe('review');
    expect(HYBRIDS.H4_no_auto_preserved_critical_review(mismatch).by).toBe('critical-review');
  });

  it('routes a critical mismatch to review even when the pair really did change', () => {
    // The demotion is unconditional: H4 does not get to keep the vetoes that
    // happen to be right. That is the cost being measured.
    const mismatch = ctx({
      critical: CRITICAL_MISMATCH,
      runs: runsOf('changed', 'changed', 'changed'),
    });
    expect(HYBRIDS.H4_no_auto_preserved_critical_review(mismatch).decision).toBe('review');
  });

  it('decides changed on a full-run-unanimous rubric changed with no critical signal', () => {
    const outcome = HYBRIDS.H4_no_auto_preserved_critical_review(ctx());
    expect(outcome.decision).toBe('changed');
    expect(outcome.by).toBe('llm-changed');
  });

  it('sends a preserved rubric result to review, never to preserved', () => {
    const preserved = ctx({ runs: runsOf('preserved', 'preserved', 'preserved') });
    expect(HYBRIDS.H4_no_auto_preserved_critical_review(preserved).decision).toBe('review');
  });

  it('sends missing or split evidence to review', () => {
    for (const runs of [
      runsOf('changed', 'changed', null), // an invalid run
      runsOf('changed', 'preserved', 'changed'), // a split vote
      runsOf('changed', 'changed'), // a run that never happened
      runsOf(null, null, null), // nothing usable at all
    ]) {
      expect(HYBRIDS.H4_no_auto_preserved_critical_review(ctx({ runs })).decision).toBe('review');
    }
  });

  it('never emits an automatic preserved, whatever it is given', () => {
    for (const critical of [NO_CRITICAL, CRITICAL_MISMATCH]) {
      for (const runs of [
        runsOf('preserved', 'preserved', 'preserved'),
        runsOf('changed', 'changed', 'changed'),
        runsOf('preserved', 'changed', 'preserved'),
        runsOf('preserved', 'preserved', null),
      ]) {
        expect(
          HYBRIDS.H4_no_auto_preserved_critical_review(ctx({ runs, critical })).decision,
        ).not.toBe('preserved');
      }
    }
  });
});

describe('H4 in the published evidence', () => {
  const summary = JSON.parse(
    readFileSync(path.join(EVIDENCE_DIR, 'analysis-summary.json'), 'utf8'),
  );
  const variants = Object.entries(summary.hybrid.variants).filter(([name]) =>
    name.startsWith('H4_no_auto_preserved_critical_review'),
  );

  it('is scored at every threshold and input, and auto-preserves nothing', () => {
    expect(variants.length).toBe(6); // 2 input variants x 3 thresholds
    for (const [name, data] of variants) {
      expect(data.auto_preserved, name).toBe(0);
      expect(data.hard_negative_auto_preserved_count, name).toBe(0);
      expect(data.false_preserved, name).toBe(0);
    }
  });

  it('does not move with the embedding threshold', () => {
    // H4 reads no embedding, so three thresholds must produce one answer. If
    // this ever fails, the rule has picked up a dependency it should not have.
    for (const input of ['raw', 'surface']) {
      const answers = ['0.85', '0.9', '0.95'].map((t) =>
        JSON.stringify(
          summary.hybrid.variants[
            'H4_no_auto_preserved_critical_review__' + input + '__t' + t
          ],
        ),
      );
      expect(new Set(answers).size, input).toBe(1);
    }
    expect(summary.hybrid.threshold_independent_rules).toContain(
      'H4_no_auto_preserved_critical_review',
    );
  });

  it('keeps the corpus denominator and does not conflate the two hard-negative metrics', () => {
    for (const [name, data] of variants) {
      expect(data.hard_negative_total, name).toBe(13);
      // Every hard negative is either detected or reviewed; none is preserved.
      expect(data.hard_negative_auto_changed_count + data.hard_negative_review_count, name).toBe(13);
      expect(data.hard_negative_non_preserved_coverage, name).toBe('100.0%');
      // Coverage is 100% because nothing is auto-preserved. Detection is not,
      // because reviewing is not detecting — the whole point of two names.
      expect(data.hard_negative_auto_changed_recall, name).not.toBe('100.0%');
      expect(data.hard_negative_auto_changed_recall, name).toBe(
        `${((data.hard_negative_auto_changed_count / 13) * 100).toFixed(1)}%`,
      );
    }
  });

  it('p12 is the pair the two rules disagree about', () => {
    // The human review confirmed p12 as `preserved` while the critical signal
    // reports a mismatch on it. Under H3 that is a deterministic false changed —
    // no model involved, no threshold that moves it. Under H4 it reaches a
    // person. This is the trade the adoption decision turns on.
    const h3 = summary.hybrid.variants['H3_no_auto_preserved__surface__t0.9'];
    const h4 = summary.hybrid.variants['H4_no_auto_preserved_critical_review__surface__t0.9'];

    expect(h3.false_changed_ids).toContain('p12');
    expect(h3.review_ids).not.toContain('p12');

    expect(h4.false_changed_ids).not.toContain('p12');
    expect(h4.review_ids).toContain('p12');

    // And it costs exactly one false changed, paid for in review load.
    expect(h4.false_changed).toBe(h3.false_changed - 1);
    expect(h4.review_count).toBeGreaterThan(h3.review_count);
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

  it('the gap between the two levels is exactly the pairs missing a reply', () => {
    // R1's report made a flat "unanimous 100%" claim that hid three pairs with
    // an unparseable reply. Whether any given run has such pairs varies — this
    // run has none — so the invariant is pinned rather than the count: the two
    // levels may only differ by pairs that are actually missing a reply.
    for (const [variant, data] of Object.entries(summary.llm_rubric)) {
      if (data.status !== 'OK') continue;
      expect(data.pairs_with_an_invalid_run, variant).toBe(
        data.valid_vote_unanimous_pairs - data.full_run_unanimous_pairs,
      );
      expect(data.pairs_with_an_invalid_run_ids, variant).toHaveLength(
        data.pairs_with_an_invalid_run,
      );
      if (data.invalid_runs === 0) {
        expect(data.full_run_unanimous_rate, variant).toBe(data.valid_vote_unanimous_rate);
      }
    }
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
