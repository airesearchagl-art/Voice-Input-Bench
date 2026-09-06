/**
 * Which text a Generate would actually use, decided before the request is sent.
 *
 * The page and the server can disagree about the source of a Run. If the case
 * list fails to load while a case is selected, the page has no body to show and
 * falls back to the manual textarea — but `testId` still names the case, so the
 * server would synthesize the case body while the operator was looking at their
 * own text. That mismatch produces a Run whose audio does not match what the
 * person thought they were running.
 *
 * So the decision is made once, here, from the state the page can actually see:
 * a Run is only allowed when the selected source is fully resolved. Anything
 * else blocks Generate.
 *
 * Kept free of engine and filesystem imports so it can be unit tested directly
 * and used from the client bundle without dragging the case bodies along.
 */

/** `test_id` used when the operator typed the text themselves. */
export const MANUAL_TEST_ID = 'manual';

export type SourceSelectionBlockReason =
  /** Manual mode with nothing typed. */
  | 'EMPTY_TEXT'
  /** A case is selected but the case list is not loaded, so its body is unknown. */
  | 'CASE_NOT_LOADED';

export type SourceSelection =
  | { ready: true; source: 'manual' }
  | { ready: true; source: 'case'; caseId: string }
  | { ready: false; reason: SourceSelectionBlockReason };

export interface SourceSelectionInput {
  testId: string;
  /** Raw textarea contents. Only consulted in manual mode. */
  text: string;
  /** IDs the page has actually loaded from `GET /api/cases`. */
  knownCaseIds: readonly string[];
}

export function resolveSourceSelection(input: SourceSelectionInput): SourceSelection {
  if (input.testId === MANUAL_TEST_ID) {
    // trim() decides emptiness only; the untrimmed text is what gets sent.
    return input.text.trim().length > 0
      ? { ready: true, source: 'manual' }
      : { ready: false, reason: 'EMPTY_TEXT' };
  }

  return input.knownCaseIds.includes(input.testId)
    ? { ready: true, source: 'case', caseId: input.testId }
    : { ready: false, reason: 'CASE_NOT_LOADED' };
}
