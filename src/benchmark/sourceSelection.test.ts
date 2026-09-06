import { describe, expect, it } from 'vitest';
import { MANUAL_TEST_ID, resolveSourceSelection } from './sourceSelection';

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
