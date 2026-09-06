import { describe, expect, it } from 'vitest';
import {
  MANUAL_TEST_ID,
  beginCasesLoad,
  casesLoadFailed,
  casesLoaded,
  idleCases,
  resolveSourceSelection,
} from './sourceSelection';

const CASE_IDS = ['architecture-short-001', 'architecture-long-001'];

describe('manual mode', () => {
  it('is ready when text has been typed', () => {
    expect(
      resolveSourceSelection({ testId: MANUAL_TEST_ID, text: 'あ', knownCaseIds: CASE_IDS }),
    ).toEqual({ ready: true, source: 'manual' });
  });

  it('is ready for text that is only meaningful once untrimmed', () => {
    expect(
      resolveSourceSelection({ testId: MANUAL_TEST_ID, text: '  あ  ', knownCaseIds: [] }),
    ).toEqual({ ready: true, source: 'manual' });
  });

  it('blocks on empty or whitespace-only text', () => {
    for (const text of ['', '   ', '\n\t ']) {
      expect(resolveSourceSelection({ testId: MANUAL_TEST_ID, text, knownCaseIds: CASE_IDS })).toEqual(
        { ready: false, reason: 'EMPTY_TEXT' },
      );
    }
  });

  it('does not care whether the case list loaded', () => {
    expect(resolveSourceSelection({ testId: MANUAL_TEST_ID, text: 'あ', knownCaseIds: [] })).toEqual(
      { ready: true, source: 'manual' },
    );
  });
});

describe('case mode', () => {
  it('is ready when the selected case is loaded', () => {
    expect(
      resolveSourceSelection({
        testId: 'architecture-long-001',
        text: '',
        knownCaseIds: CASE_IDS,
      }),
    ).toEqual({ ready: true, source: 'case', caseId: 'architecture-long-001' });
  });

  it('ignores the textarea contents entirely', () => {
    expect(
      resolveSourceSelection({
        testId: 'architecture-long-001',
        text: 'client side text that must not be used',
        knownCaseIds: CASE_IDS,
      }),
    ).toEqual({ ready: true, source: 'case', caseId: 'architecture-long-001' });
  });

  it('blocks when the case list failed to load', () => {
    // The stale-state bug this guards: testId still names a case, the case body
    // is unknown, the manual textarea is visible — and Generate would have sent
    // the case ID while the operator was reading their own text.
    expect(
      resolveSourceSelection({
        testId: 'architecture-long-001',
        text: 'whatever the manual box happens to hold',
        knownCaseIds: [],
      }),
    ).toEqual({ ready: false, reason: 'CASE_NOT_LOADED' });
  });

  it('blocks on a case ID the page has never seen', () => {
    expect(
      resolveSourceSelection({ testId: 'no-such-case', text: 'あ', knownCaseIds: CASE_IDS }),
    ).toEqual({ ready: false, reason: 'CASE_NOT_LOADED' });
  });

  it('blocks on a partially loaded list that omits the selection', () => {
    expect(
      resolveSourceSelection({
        testId: 'architecture-long-001',
        text: 'あ',
        knownCaseIds: ['architecture-short-001'],
      }),
    ).toEqual({ ready: false, reason: 'CASE_NOT_LOADED' });
  });
});

describe('cases load state', () => {
  interface Summary {
    id: string;
  }
  const LOADED: Summary[] = [{ id: 'architecture-short-001' }, { id: 'architecture-long-001' }];
  const ids = (state: { cases: readonly Summary[] }) => state.cases.map((c) => c.id);

  it('starts empty', () => {
    expect(idleCases<Summary>()).toEqual({ status: 'idle', cases: [] });
  });

  it('holds the list only after a successful load', () => {
    const state = casesLoaded(LOADED);
    expect(state.status).toBe('loaded');
    expect(ids(state)).toEqual(['architecture-short-001', 'architecture-long-001']);
  });

  it('clears the list the moment a reload starts', () => {
    expect(beginCasesLoad<Summary>()).toEqual({ status: 'loading', cases: [] });
  });

  it('clears the list on a failed load', () => {
    expect(casesLoadFailed<Summary>()).toEqual({ status: 'failed', cases: [] });
  });
});

describe('a failed reload does not leave previous case evidence standing', () => {
  interface Summary {
    id: string;
  }
  const LOADED: Summary[] = [{ id: 'architecture-short-001' }, { id: 'architecture-long-001' }];
  const STALE_TEST_ID = 'architecture-long-001';
  const MANUAL_TEXT = '手入力のテキストです。';

  const selectionFor = (state: { cases: readonly Summary[] }, testId: string, text: string) =>
    resolveSourceSelection({
      testId,
      text,
      knownCaseIds: state.cases.map((benchmarkCase) => benchmarkCase.id),
    });

  it('walks the whole sequence: loaded -> reload -> HTTP 500 -> blocked', () => {
    // 1. previous cases are loaded and the selected case is usable
    let state = casesLoaded<Summary>(LOADED);
    expect(selectionFor(state, STALE_TEST_ID, MANUAL_TEXT)).toEqual({
      ready: true,
      source: 'case',
      caseId: STALE_TEST_ID,
    });

    // 2. a reload starts: previous evidence is invalidated immediately
    state = beginCasesLoad<Summary>();
    expect(state.cases).toEqual([]);
    expect(selectionFor(state, STALE_TEST_ID, MANUAL_TEXT)).toEqual({
      ready: false,
      reason: 'CASE_NOT_LOADED',
    });

    // 3. the reload comes back HTTP 500: the list stays empty
    state = casesLoadFailed<Summary>();
    expect(state.cases).toEqual([]);

    // 4. the stale case testId is still selected, but it is not confirmed
    const selection = selectionFor(state, STALE_TEST_ID, MANUAL_TEXT);
    expect(selection).toEqual({ ready: false, reason: 'CASE_NOT_LOADED' });

    // 5. so Generate stays disabled
    expect(selection.ready).toBe(false);

    // 6. manual mode still works
    expect(selectionFor(state, MANUAL_TEST_ID, MANUAL_TEXT)).toEqual({
      ready: true,
      source: 'manual',
    });
  });

  it('blocks even when the failed reload leaves an unrelated selection', () => {
    const state = casesLoadFailed<Summary>();
    for (const testId of ['architecture-short-001', 'filler-001', 'coding-001']) {
      expect(selectionFor(state, testId, MANUAL_TEXT)).toEqual({
        ready: false,
        reason: 'CASE_NOT_LOADED',
      });
    }
  });

  it('re-establishes case evidence once a fresh load succeeds', () => {
    const state = casesLoaded<Summary>(LOADED);
    expect(selectionFor(state, STALE_TEST_ID, '')).toEqual({
      ready: true,
      source: 'case',
      caseId: STALE_TEST_ID,
    });
  });
});
