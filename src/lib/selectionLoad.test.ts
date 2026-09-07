import { describe, expect, it } from 'vitest';
import {
  applyFailed,
  applyLoaded,
  idleSelection,
  isCurrentResponse,
  selectTarget,
} from './selectionLoad';

interface Payload {
  label: string;
}

const A = 'session-a';
const B = 'session-b';

describe('selection lifecycle', () => {
  it('starts idle with nothing selected', () => {
    expect(idleSelection<Payload>()).toEqual({
      selected: null,
      requestId: 0,
      status: 'idle',
      value: null,
      error: null,
    });
  });

  it('clears the previous value the moment the selection changes', () => {
    let state = idleSelection<Payload>();
    state = selectTarget(state, A);
    state = applyLoaded(state, { requestId: state.requestId, selected: A, value: { label: 'A' } });
    expect(state.value).toEqual({ label: 'A' });

    state = selectTarget(state, B);
    expect(state.value).toBeNull();
    expect(state.status).toBe('loading');
  });

  it('mints a new request id on every selection change', () => {
    let state = idleSelection<Payload>();
    state = selectTarget(state, A);
    const first = state.requestId;
    state = selectTarget(state, B);
    expect(state.requestId).toBeGreaterThan(first);
  });

  it('goes back to idle when the selection is cleared', () => {
    let state = selectTarget(idleSelection<Payload>(), A);
    state = selectTarget(state, null);
    expect(state.status).toBe('idle');
    expect(state.selected).toBeNull();
  });
});

describe('stale response protection', () => {
  it('applies a response that matches the current request', () => {
    let state = selectTarget(idleSelection<Payload>(), A);
    state = applyLoaded(state, { requestId: state.requestId, selected: A, value: { label: 'A' } });
    expect(state.status).toBe('loaded');
    expect(state.value).toEqual({ label: 'A' });
  });

  it('drops a late response for a Session that is no longer selected', () => {
    // Select A, start its fetch, select B, then A's response arrives late.
    let state = selectTarget(idleSelection<Payload>(), A);
    const staleRequestId = state.requestId;

    state = selectTarget(state, B);
    const afterSwitch = state;

    state = applyLoaded(state, {
      requestId: staleRequestId,
      selected: A,
      value: { label: 'A (late)' },
    });

    expect(state).toBe(afterSwitch);
    expect(state.selected).toBe(B);
    expect(state.value).toBeNull();
  });

  it('drops a late failure for a Session that is no longer selected', () => {
    let state = selectTarget(idleSelection<Payload>(), A);
    const staleRequestId = state.requestId;
    state = selectTarget(state, B);
    state = applyLoaded(state, { requestId: state.requestId, selected: B, value: { label: 'B' } });

    const beforeStale = state;
    state = applyFailed(state, { requestId: staleRequestId, selected: A, error: 'boom' });

    expect(state).toBe(beforeStale);
    expect(state.value).toEqual({ label: 'B' });
    expect(state.error).toBeNull();
  });

  it('drops a response whose request id matches but whose selection does not', () => {
    let state = selectTarget(idleSelection<Payload>(), A);
    const before = state;
    state = applyLoaded(state, {
      requestId: state.requestId,
      selected: B,
      value: { label: 'wrong session' },
    });
    expect(state).toBe(before);
  });

  it('drops a response whose selection matches but whose request id is old', () => {
    // Re-selecting the same Session still invalidates the earlier request.
    let state = selectTarget(idleSelection<Payload>(), A);
    const staleRequestId = state.requestId;
    state = selectTarget(state, A);

    const before = state;
    state = applyLoaded(state, {
      requestId: staleRequestId,
      selected: A,
      value: { label: 'A (stale reload)' },
    });
    expect(state).toBe(before);
  });

  it('accepts the newer response after an out-of-order pair', () => {
    let state = selectTarget(idleSelection<Payload>(), A);
    const staleRequestId = state.requestId;
    state = selectTarget(state, B);
    const currentRequestId = state.requestId;

    // B lands first, then A arrives late.
    state = applyLoaded(state, { requestId: currentRequestId, selected: B, value: { label: 'B' } });
    state = applyLoaded(state, { requestId: staleRequestId, selected: A, value: { label: 'A' } });

    expect(state.selected).toBe(B);
    expect(state.value).toEqual({ label: 'B' });
  });
});

describe('isCurrentResponse', () => {
  it('is true only for the current generation and selection', () => {
    const state = selectTarget(idleSelection<Payload>(), A);
    expect(isCurrentResponse(state, { requestId: state.requestId, selected: A })).toBe(true);
    expect(isCurrentResponse(state, { requestId: state.requestId, selected: B })).toBe(false);
    expect(isCurrentResponse(state, { requestId: state.requestId - 1, selected: A })).toBe(false);
  });
});
