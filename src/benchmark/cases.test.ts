import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES, MANUAL_TEST_ID, getBenchmarkCase, isBenchmarkCaseId } from './cases';
import { toCanonicalText } from '@/lib/canonicalText';
import { countCodePoints } from './splitter';

const EXPECTED_IDS = [
  'architecture-short-001',
  'architecture-long-001',
  'filler-001',
  'correction-001',
  'numbers-units-001',
  'coding-001',
];

describe('case registry', () => {
  it('ships exactly the expected built-in cases', () => {
    expect(BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.id)).toEqual(EXPECTED_IDS);
  });

  it('has no duplicate IDs', () => {
    const ids = BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a case up by ID', () => {
    for (const id of EXPECTED_IDS) {
      expect(getBenchmarkCase(id)?.id).toBe(id);
      expect(isBenchmarkCaseId(id)).toBe(true);
    }
  });

  it('does not resolve unknown IDs, and never resolves the manual sentinel', () => {
    expect(getBenchmarkCase('does-not-exist')).toBeUndefined();
    expect(isBenchmarkCaseId('does-not-exist')).toBe(false);
    expect(isBenchmarkCaseId(MANUAL_TEST_ID)).toBe(false);
    expect(isBenchmarkCaseId('')).toBe(false);
  });

  it('gives every case a title and an intent', () => {
    for (const benchmarkCase of BENCHMARK_CASES) {
      expect(benchmarkCase.title.trim()).not.toBe('');
      expect(benchmarkCase.intent.trim()).not.toBe('');
    }
  });
});

describe('case bodies are the server-side source of truth', () => {
  it('stores every body already canonical, so reading it changes nothing', () => {
    for (const benchmarkCase of BENCHMARK_CASES) {
      expect(toCanonicalText(benchmarkCase.text)).toBe(benchmarkCase.text);
    }
  });

  it('contains no CR characters', () => {
    for (const benchmarkCase of BENCHMARK_CASES) {
      expect(benchmarkCase.text.includes('\r')).toBe(false);
    }
  });

  it('has a non-empty body for every case', () => {
    for (const benchmarkCase of BENCHMARK_CASES) {
      expect(benchmarkCase.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('freezes the registry entries so a request handler cannot edit them', () => {
    const first = BENCHMARK_CASES[0]!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { text: string }).text = 'tampered';
    }).toThrow();
    expect(getBenchmarkCase(first.id)?.text).not.toBe('tampered');
  });

  it('returns the same body on every lookup', () => {
    const a = getBenchmarkCase('architecture-long-001')!.text;
    const b = getBenchmarkCase('architecture-long-001')!.text;
    expect(a).toBe(b);
  });
});

describe('case content requirements', () => {
  it('architecture-long-001 is long enough to need splitting', () => {
    const longCase = getBenchmarkCase('architecture-long-001')!;
    expect(countCodePoints(longCase.text)).toBeGreaterThan(450);
  });

  it('architecture-short-001 fits in one segment', () => {
    const shortCase = getBenchmarkCase('architecture-short-001')!;
    expect(countCodePoints(shortCase.text)).toBeLessThanOrEqual(450);
  });

  const NUMBERS_UNITS_REQUIRED = ['2700mm', '320㎡', '590㎥/h', '3m/s', '午前10時'];

  for (const token of NUMBERS_UNITS_REQUIRED) {
    it(`numbers-units-001 contains ${token}`, () => {
      expect(getBenchmarkCase('numbers-units-001')!.text).toContain(token);
    });
  }

  const CODING_REQUIRED = ['BIM', 'Revit', 'GitHub', 'PR', 'commit SHA', 'npm run build'];

  for (const token of CODING_REQUIRED) {
    it(`coding-001 contains ${token}`, () => {
      expect(getBenchmarkCase('coding-001')!.text).toContain(token);
    });
  }

  it('filler-001 actually contains fillers', () => {
    const text = getBenchmarkCase('filler-001')!.text;
    const fillers = ['えーと', 'あの', 'まあ', 'そのー'];
    expect(fillers.filter((filler) => text.includes(filler)).length).toBeGreaterThanOrEqual(3);
  });

  it('correction-001 actually contains a self-correction', () => {
    const text = getBenchmarkCase('correction-001')!.text;
    const corrections = ['すみません', 'いや違う', 'ではなくて'];
    expect(corrections.filter((phrase) => text.includes(phrase)).length).toBeGreaterThanOrEqual(2);
  });
});
