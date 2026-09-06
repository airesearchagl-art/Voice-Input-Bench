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

/**
 * Case-list load state.
 *
 * A reload invalidates whatever was loaded before it. Keeping the previous list
 * while a refetch is in flight — or after it came back non-OK — would let the
 * page keep offering a case whose body it can no longer confirm, and
 * {@link resolveSourceSelection} would report it as ready on the strength of
 * evidence from an earlier request.
 *
 * So only a successful fresh response establishes case evidence. Every other
 * outcome, including "still loading", leaves the list empty.
 */
export type CasesLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

export interface CasesLoadState<TCase> {
  status: CasesLoadStatus;
  cases: readonly TCase[];
}

export function idleCases<TCase>(): CasesLoadState<TCase> {
  return { status: 'idle', cases: [] };
}

/** A load has started: previous evidence is no longer current. */
export function beginCasesLoad<TCase>(): CasesLoadState<TCase> {
  return { status: 'loading', cases: [] };
}

/** The only transition that establishes case evidence. */
export function casesLoaded<TCase>(cases: readonly TCase[]): CasesLoadState<TCase> {
  return { status: 'loaded', cases };
}

/** Non-OK response, malformed body, or a thrown fetch. */
export function casesLoadFailed<TCase>(): CasesLoadState<TCase> {
  return { status: 'failed', cases: [] };
}
