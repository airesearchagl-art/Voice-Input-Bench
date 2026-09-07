import { describe, expect, it } from 'vitest';
import {
  applyFailed,
  applyLoaded,
  idleSelection,
  isStillSelected,
  selectTarget,
  type SelectionLoadState,
} from '@/lib/selectionLoad';

/**
 * Run selection safety for the Manual STT Results panel.
 *
 * The panel reads Results per Run. A Result list means nothing on its own — it
 * is only ever "what Run X produced" — so showing Run A's transcripts under Run
 * B's name and audio hash is not a cosmetic glitch, it is a false observation.
 *
 * These exercise the exact call sequence `ManualSttResults` performs: every Run
 * change goes through `selectTarget`, every response through `applyLoaded` /
 * `applyFailed` with the generation it was issued under, and the reload after a
 * save is gated on `isStillSelected`. No renderer is involved, because the rule
 * being checked is not a rendering rule.
 */

interface ResultEntry {
  resultId: string;
}

interface ApiErrorShape {
  kind: string;
  message: string;
  detail?: string;
}

type ResultsState = SelectionLoadState<ResultEntry[], ApiErrorShape>;

const RUN_A = '20260907T010000000Z-aaaaaaaa';
const RUN_B = '20260907T010001000Z-bbbbbbbb';

const RESULTS_A: ResultEntry[] = [{ resultId: 'result-a' }];
const RESULTS_B: ResultEntry[] = [{ resultId: 'result-b' }];

const ERROR_A: ApiErrorShape = { kind: 'RUN_NOT_FOUND', message: 'Run A は読めません。' };

function idle(): ResultsState {
  return idleSelection<ResultEntry[], ApiErrorShape>();
}

/** What the panel captures when it issues a request, before awaiting it. */
function issue(state: ResultsState, runId: string) {
  const next = selectTarget(state, runId === '' ? null : runId);
  return { state: next, requestId: next.requestId, selected: next.selected };
}

describe('Manual STT Result loading is tied to the selected Run', () => {
  it('drops the previous Run’s Results the moment the selection changes', () => {
    let state = idle();
    const a = issue(state, RUN_A);
    state = applyLoaded(a.state, { requestId: a.requestId, selected: a.selected, value: RESULTS_A });
    expect(state.value).toEqual(RESULTS_A);

    const b = issue(state, RUN_B);
    // Nothing from Run A is on screen while Run B loads.
    expect(b.state.value).toBeNull();
    expect(b.state.status).toBe('loading');
    expect(b.state.selected).toBe(RUN_B);
  });

  it('ignores a late success from the Run the operator left', () => {
    let state = idle();
    const a = issue(state, RUN_A);
    const b = issue(a.state, RUN_B);

    state = applyLoaded(b.state, {
      requestId: b.requestId,
      selected: b.selected,
      value: RESULTS_B,
    });
    // Run A's response finally lands.
    state = applyLoaded(state, {
      requestId: a.requestId,
      selected: a.selected,
      value: RESULTS_A,
    });

    expect(state.selected).toBe(RUN_B);
    expect(state.status).toBe('loaded');
    expect(state.value).toEqual(RESULTS_B);
  });

  it('ignores a late failure from the Run the operator left', () => {
    let state = idle();
    const a = issue(state, RUN_A);
    const b = issue(a.state, RUN_B);

    state = applyLoaded(b.state, {
      requestId: b.requestId,
      selected: b.selected,
      value: RESULTS_B,
    });
    state = applyFailed(state, { requestId: a.requestId, selected: a.selected, error: ERROR_A });

    // Run B is fine. Run A's problem is not Run B's problem.
    expect(state.status).toBe('loaded');
    expect(state.error).toBeNull();
    expect(state.value).toEqual(RESULTS_B);
  });

  it('stays idle when a late response arrives after the selection is cleared', () => {
    const a = issue(idle(), RUN_A);
    const cleared = issue(a.state, '');
    expect(cleared.state.status).toBe('idle');
    expect(cleared.state.selected).toBeNull();

    const afterSuccess = applyLoaded(cleared.state, {
      requestId: a.requestId,
      selected: a.selected,
      value: RESULTS_A,
    });
    const afterFailure = applyFailed(afterSuccess, {
      requestId: a.requestId,
      selected: a.selected,
      error: ERROR_A,
    });

    expect(afterFailure.status).toBe('idle');
    expect(afterFailure.value).toBeNull();
    expect(afterFailure.error).toBeNull();
  });

  it('applies a response that is still the current one', () => {
    const a = issue(idle(), RUN_A);
    const state = applyLoaded(a.state, {
      requestId: a.requestId,
      selected: a.selected,
      value: RESULTS_A,
    });

    expect(state.status).toBe('loaded');
    expect(state.value).toEqual(RESULTS_A);
    expect(state.selected).toBe(RUN_A);
  });

  it('surfaces a failure for the Run that is actually selected', () => {
    const a = issue(idle(), RUN_A);
    const state = applyFailed(a.state, {
      requestId: a.requestId,
      selected: a.selected,
      error: ERROR_A,
    });

    expect(state.status).toBe('failed');
    expect(state.error).toEqual(ERROR_A);
    expect(state.value).toBeNull();
  });

  it('treats re-selecting the same Run as a fresh generation', () => {
    const first = issue(idle(), RUN_A);
    const reloaded = issue(first.state, RUN_A);

    expect(reloaded.requestId).toBeGreaterThan(first.requestId);
    // The first request's response is stale even though the Run is unchanged.
    const state = applyLoaded(reloaded.state, {
      requestId: first.requestId,
      selected: first.selected,
      value: RESULTS_A,
    });
    expect(state.status).toBe('loading');
    expect(state.value).toBeNull();
  });
});

describe('a save that finishes after the operator moved on', () => {
  it('does not reload the saved Run over the Run now on screen', () => {
    let state = idle();
    const a = issue(state, RUN_A);
    state = applyLoaded(a.state, { requestId: a.requestId, selected: a.selected, value: RESULTS_A });

    // Save starts for Run A, capturing the Run it is saving to.
    const savedRunId = RUN_A;

    // The operator switches to Run B while the POST is in flight.
    const b = issue(state, RUN_B);
    state = applyLoaded(b.state, { requestId: b.requestId, selected: b.selected, value: RESULTS_B });

    // The POST completes. The panel checks before starting the follow-up read.
    expect(isStillSelected(state, savedRunId)).toBe(false);

    // So no reload is issued, and Run B keeps its own Results.
    expect(state.selected).toBe(RUN_B);
    expect(state.value).toEqual(RESULTS_B);
  });

  it('does not clear a transcript typed for the Run now on screen', () => {
    // Same sequence: the guard that skips the reload is the guard that skips
    // emptying the textarea, because both belong to the saved Run.
    let state = idle();
    const a = issue(state, RUN_A);
    state = applyLoaded(a.state, { requestId: a.requestId, selected: a.selected, value: RESULTS_A });
    const b = issue(state, RUN_B);
    state = applyLoaded(b.state, { requestId: b.requestId, selected: b.selected, value: RESULTS_B });

    let transcriptBox = 'Run B 用に貼り付けた途中のテキスト';
    if (isStillSelected(state, RUN_A)) transcriptBox = '';

    expect(transcriptBox).toBe('Run B 用に貼り付けた途中のテキスト');
  });

  it('does reload when the operator never left the saved Run', () => {
    let state = idle();
    const a = issue(state, RUN_A);
    state = applyLoaded(a.state, { requestId: a.requestId, selected: a.selected, value: RESULTS_A });

    expect(isStillSelected(state, RUN_A)).toBe(true);

    const reload = issue(state, RUN_A);
    state = applyLoaded(reload.state, {
      requestId: reload.requestId,
      selected: reload.selected,
      value: [...RESULTS_A, { resultId: 'result-a2' }],
    });

    expect(state.selected).toBe(RUN_A);
    expect(state.value).toHaveLength(2);
  });

  it('ignores a stale reload response issued before the switch', () => {
    // The reload was already in flight when the operator switched Runs.
    let state = idle();
    const a = issue(state, RUN_A);
    const b = issue(a.state, RUN_B);
    state = applyLoaded(b.state, { requestId: b.requestId, selected: b.selected, value: RESULTS_B });

    state = applyLoaded(state, {
      requestId: a.requestId,
      selected: RUN_A,
      value: [...RESULTS_A, { resultId: 'result-a2' }],
    });

    expect(state.selected).toBe(RUN_B);
    expect(state.value).toEqual(RESULTS_B);
  });
});
