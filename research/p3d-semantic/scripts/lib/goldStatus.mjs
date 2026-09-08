/**
 * How an accuracy figure from this corpus may be described.
 *
 * The wording is derived from `gold_provenance`, never written by hand, so a
 * document or an evidence file cannot claim more confirmation than the corpus
 * records. While the labels were proposals every figure had to say so; now that
 * a person has reviewed all 28 and approved them unchanged, the same figures are
 * accuracy against human-reviewed labels.
 *
 * `authoring` is deliberately not part of the decision. The research agent wrote
 * the labels and that stays true after review — authorship and review are two
 * facts, and a promotion must not overwrite the first with the second.
 */

/** @param provenance the corpus `gold_provenance` block */
export function goldStatus(provenance) {
  const status = provenance?.human_review_status ?? 'unknown';
  const reviewed = status === 'approved';

  return {
    human_review_status: status,
    human_reviewed: reviewed,
    accuracy_label: reviewed ? 'accuracy against human-reviewed labels' : 'provisional accuracy against proposed labels',
    caveat: reviewed
      ? `Labels were proposed by ${provenance.authoring} and reviewed by a human on ${provenance.human_reviewed_at}: ${provenance.human_reviewed_pair_count} pairs reviewed, ${provenance.human_label_change_count} labels changed. Accuracy computed from this file is accuracy against human-reviewed labels. See HUMAN_GOLD_REVIEW.md.`
      : 'Any accuracy computed from this file is provisional accuracy against proposed labels. The labels have not been confirmed by a human; see HUMAN_GOLD_REVIEW.md.',
    short: reviewed ? 'human-reviewed labels' : 'proposed labels, unconfirmed',
  };
}
