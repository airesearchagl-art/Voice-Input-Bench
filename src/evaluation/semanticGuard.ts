import { sha256OfText } from '@/lib/hash';
import { analyzeCriticalInfo, CriticalInfoError } from './criticalInfo';
import { toStoredEntity, toStoredMatch } from './criticalEvaluationSchema';
import { toCodePoints } from './rawChar';
import { surfaceNormalize } from './surfaceNormalize';
import type { NormalizedSide } from './surfaceEvaluationSchema';
import type { SemanticCriticalGuardV4 } from './semanticEvaluationSchema';

/**
 * The deterministic half of semantic-h3-v1, shared by writing and readback.
 *
 * Both paths call exactly these functions on exactly the same bytes, which is
 * what makes "recompute the guard at readback and compare" a real check rather
 * than two implementations agreeing by luck.
 */

export interface SemanticNormalizedInput {
  text: string;
  side: NormalizedSide;
}

/**
 * Fold typography, then record what the fold produced.
 *
 * The hash and the length travel with the text because the text itself is not
 * stored in the artifact: `sha256` plus `chars` is what lets a reader confirm
 * that the string they just normalized is the string the model was shown.
 */
export function normalizeSemanticInput(text: string): SemanticNormalizedInput {
  const normalized = surfaceNormalize(text);
  return {
    text: normalized,
    side: { sha256: sha256OfText(normalized), chars: toCodePoints(normalized).length },
  };
}

/**
 * Run critical-info-v1 over the normalized texts, as a veto.
 *
 * It runs on the *normalized* pair on purpose. semantic-h3-v1 declares one
 * input profile for the whole evaluator, and a guard reading different bytes
 * than the model does would be guarding a different comparison.
 *
 * The two refusal paths are recorded, never swallowed. critical-info-v1 throws
 * when the reference has no facts to check, and again when the reference uses
 * numeric syntax its grammar does not support. Neither is a clean bill of
 * health, so neither sets `mismatch`, and neither is allowed to look like the
 * guard ran. The grammar is not widened here: an unsupported reference is
 * reported as unsupported and the decision falls through to a route that
 * cannot conclude `preserved` in any case.
 */
export function runSemanticCriticalGuard(
  normalizedReference: string,
  normalizedHypothesis: string,
): SemanticCriticalGuardV4 {
  let analysis: ReturnType<typeof analyzeCriticalInfo>;
  try {
    analysis = analyzeCriticalInfo(normalizedReference, normalizedHypothesis);
  } catch (caught) {
    if (caught instanceof CriticalInfoError) {
      return {
        status:
          caught.kind === 'CRITICAL_INFO_NO_REFERENCE_ENTITY'
            ? 'not_applicable_no_reference_entity'
            : 'unsupported_reference_syntax',
        applicable: false,
        mismatch: false,
        entities: null,
        matches: null,
        missing: null,
        extra: null,
        metrics: null,
        // The error *kind*, not its message: a closed vocabulary stays stable
        // for recomputation, where prose would drift with an edit to the text.
        unavailable_reason: caught.kind,
      };
    }
    throw caught;
  }

  return {
    status: 'applied',
    applicable: true,
    mismatch: !analysis.metrics.exact_entity_multiset_match,
    entities: {
      reference: analysis.referenceEntities.map(toStoredEntity),
      hypothesis: analysis.hypothesisEntities.map(toStoredEntity),
    },
    matches: analysis.matches.map(toStoredMatch),
    missing: analysis.missing.map(toStoredEntity),
    extra: analysis.extra.map(toStoredEntity),
    metrics: analysis.metrics,
    unavailable_reason: null,
  };
}
