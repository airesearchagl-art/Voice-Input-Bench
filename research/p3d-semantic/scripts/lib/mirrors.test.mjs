import { describe, expect, it } from 'vitest';
import { surfaceNormalize } from '@/evaluation/surfaceNormalize';
import { analyzeCriticalInfo, extractCriticalEntities } from '@/evaluation/criticalInfo';
import { surfaceNormalizeMirror } from './surfaceNormalizeMirror.mjs';
import { criticalSignal, extractCritical } from './criticalInfoMirror.mjs';
import { loadProbes } from './probes.mjs';

/**
 * The research mirrors must agree with the shipped evaluators.
 *
 * Two of the spike's conclusions depend on running production semantics from a
 * plain `.mjs` script: whether a semantic method should read raw or normalized
 * text, and whether a critical-information mismatch is a usable veto. An
 * approximation would answer a different question and nobody would notice.
 *
 * These tests are the thing that keeps the mirrors honest. If production
 * changes, they fail here rather than the research numbers quietly becoming
 * about code that no longer exists.
 */

const { probes } = loadProbes();

describe('surfaceNormalizeMirror matches production surface-normalize-v1', () => {
  it('agrees on every probe text', () => {
    for (const probe of probes) {
      expect(surfaceNormalizeMirror(probe.reference)).toBe(surfaceNormalize(probe.reference));
      expect(surfaceNormalizeMirror(probe.hypothesis)).toBe(surfaceNormalize(probe.hypothesis));
    }
  });

  it('agrees on the profile’s own edge cases', () => {
    const cases = [
      'ＧitHub　 PR',
      '  です。  ',
      'a\n b ',
      '㎡ m² 二千七百',
      'ＡＢＣ１２３',
      'hello　 world',
      '項目、確認',
      'a\tb',
      '😀AB',
      '',
      '   ',
      'ﾐﾘ',
      'が',
    ];
    for (const text of cases) {
      expect(surfaceNormalizeMirror(text)).toBe(surfaceNormalize(text));
    }
  });

  it('agrees across the whole fullwidth ASCII block', () => {
    for (let code = 0xff01; code <= 0xff5e; code += 1) {
      const char = String.fromCodePoint(code);
      expect(surfaceNormalizeMirror(char)).toBe(surfaceNormalize(char));
    }
  });
});

describe('criticalInfoMirror matches production critical-info-v1', () => {
  it('extracts the same entities from every probe text', () => {
    for (const probe of probes) {
      for (const text of [probe.reference, probe.hypothesis]) {
        const mirrored = extractCritical(text).entities.map((entity) => entity.canonical_key);
        const production = extractCriticalEntities(text).map((entity) => entity.canonical_key);
        expect(mirrored).toEqual(production);
      }
    }
  });

  it('reports the same match outcome wherever production can be run', () => {
    for (const probe of probes) {
      const signal = criticalSignal(probe.reference, probe.hypothesis);
      if (!signal.applicable) {
        // Production throws in exactly these cases; the mirror reports them as
        // "no opinion" instead of guessing one.
        expect(() => analyzeCriticalInfo(probe.reference, probe.hypothesis)).toThrow();
        continue;
      }

      const production = analyzeCriticalInfo(probe.reference, probe.hypothesis);
      expect(signal.reference_entities).toBe(production.metrics.reference_entities);
      expect(signal.hypothesis_entities).toBe(production.metrics.hypothesis_entities);
      expect(signal.matched).toBe(production.metrics.matched);
      expect(signal.missing).toEqual(production.missing.map((entity) => entity.raw));
      expect(signal.extra).toEqual(production.extra.map((entity) => entity.raw));
      expect(signal.mismatch).toBe(!production.metrics.exact_entity_multiset_match);
    }
  });

  it('agrees on the numeral grammar’s accepted and refused forms', () => {
    const cases = [
      '2700mm',
      '二千七百ミリ',
      '三百二十平米',
      '五百九十立方メートル毎時',
      '三メートル毎秒',
      '午前10時',
      '午前十時',
      '午後10時',
      '10時30分',
      '2.7mm',
      '2千7百ミリ',
      '十百ミリ',
      '320',
      '3時間',
      '1m',
    ];
    for (const text of cases) {
      const mirrored = extractCritical(text).entities.map((entity) => entity.canonical_key);
      const production = extractCriticalEntities(text).map((entity) => entity.canonical_key);
      expect(mirrored).toEqual(production);
    }
  });
});
