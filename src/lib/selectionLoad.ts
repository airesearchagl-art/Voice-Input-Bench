/**
 * Load state for a page where the user can switch what is being loaded.
 *
 * The failure this exists to prevent: select Session A, its fetch starts,
 * select Session B, its fetch starts, then A's response arrives late and
 * overwrites the B view. The page would then show A's matrix under B's name —
 * a comparison attributed to the wrong experiment.
 *
 * Every selection change mints a new request id and clears the value. A
 * response is only applied when it carries both the current request id and the
 * current selection key; anything else is a stale response and is dropped.
 *
 * Pure and framework-free so the rule can be tested directly rather than
 * through a rendered component.
 */

export type SelectionStatus = 'idle' | 'loading' | 'loaded' | 'failed';

export interface SelectionLoadState<TValue> {
  /** What the user has selected, or `null` for nothing. */
  selected: string | null;
  /** Incremented on every selection change; identifies the in-flight request. */
  requestId: number;
  status: SelectionStatus;
  value: TValue | null;
  error: string | null;
}

export function idleSelection<TValue>(): SelectionLoadState<TValue> {
  return { selected: null, requestId: 0, status: 'idle', value: null, error: null };
}

/**
 * Switch the selection. Clears the previous value so nothing from the old
 * selection is on screen while the new one loads.
 */
export function selectTarget<TValue>(
  state: SelectionLoadState<TValue>,
  selected: string | null,
): SelectionLoadState<TValue> {
  return {
    selected,
    requestId: state.requestId + 1,
    status: selected === null ? 'idle' : 'loading',
    value: null,
    error: null,
  };
}

/** Is this response the one the current selection is waiting for? */
export function isCurrentResponse<TValue>(
  state: SelectionLoadState<TValue>,
  response: { requestId: number; selected: string | null },
): boolean {
  return state.requestId === response.requestId && state.selected === response.selected;
}

/** Apply a loaded value, or ignore it if the selection has moved on. */
export function applyLoaded<TValue>(
  state: SelectionLoadState<TValue>,
  response: { requestId: number; selected: string | null; value: TValue },
): SelectionLoadState<TValue> {
  if (!isCurrentResponse(state, response)) return state;
  return { ...state, status: 'loaded', value: response.value, error: null };
}

/** Apply a failure, or ignore it if the selection has moved on. */
export function applyFailed<TValue>(
  state: SelectionLoadState<TValue>,
  response: { requestId: number; selected: string | null; error: string },
): SelectionLoadState<TValue> {
  if (!isCurrentResponse(state, response)) return state;
  return { ...state, status: 'failed', value: null, error: response.error };
}
