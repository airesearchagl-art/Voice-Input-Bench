import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { StorageBoundaryError, assertRootIsolation, isSameOrInside } from './rootIsolation';

const RUNS = path.join(tmpdir(), 'vib-iso', 'data', 'runs');
const RESULTS = path.join(tmpdir(), 'vib-iso', 'data', 'results');

describe('isSameOrInside', () => {
  it('is true for the same directory', () => {
    expect(isSameOrInside(RUNS, RUNS)).toBe(true);
  });

  it('is true for a descendant', () => {
    expect(isSameOrInside(path.join(RUNS, 'run-1'), RUNS)).toBe(true);
    expect(isSameOrInside(path.join(RUNS, 'a', 'b', 'c'), RUNS)).toBe(true);
  });

  it('is false for a sibling', () => {
    expect(isSameOrInside(RESULTS, RUNS)).toBe(false);
    expect(isSameOrInside(RUNS, RESULTS)).toBe(false);
  });

  it('is false for a sibling whose name merely starts the same', () => {
    // A plain string prefix check would call this nested.
    expect(isSameOrInside(`${RUNS}-archive`, RUNS)).toBe(false);
  });

  it('normalizes before comparing', () => {
    expect(isSameOrInside(path.join(RUNS, 'a', '..'), RUNS)).toBe(true);
    expect(isSameOrInside(path.join(RUNS, '..', 'results'), RUNS)).toBe(false);
  });
});

describe('assertRootIsolation', () => {
  it('accepts sibling roots', () => {
    expect(() => assertRootIsolation(RUNS, RESULTS)).not.toThrow();
  });

  it('accepts entirely unrelated roots', () => {
    expect(() =>
      assertRootIsolation(path.join(tmpdir(), 'a', 'runs'), path.join(tmpdir(), 'b', 'results')),
    ).not.toThrow();
  });

  const VIOLATIONS: Array<[string, string, string]> = [
    ['equal roots', RUNS, RUNS],
    ['results inside runs', RUNS, path.join(RUNS, 'results')],
    ['results inside an existing run directory', RUNS, path.join(RUNS, '20260906T011343123Z-aabbccdd')],
    ['results deep inside runs', RUNS, path.join(RUNS, 'a', 'b', 'results')],
    ['runs inside results', path.join(RESULTS, 'runs'), RESULTS],
    ['runs deep inside results', path.join(RESULTS, 'x', 'runs'), RESULTS],
  ];

  for (const [label, runs, results] of VIOLATIONS) {
    it(`refuses ${label}`, () => {
      let caught: unknown;
      try {
        assertRootIsolation(runs, results);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageBoundaryError);
      expect((caught as StorageBoundaryError).kind).toBe('ROOT_ISOLATION_VIOLATED');
      expect((caught as StorageBoundaryError).detail).toContain('runs=');
    });
  }

  it('accepts roots that differ only by a suffix on the last segment', () => {
    expect(() => assertRootIsolation(RUNS, `${RUNS}-results`)).not.toThrow();
  });
});
