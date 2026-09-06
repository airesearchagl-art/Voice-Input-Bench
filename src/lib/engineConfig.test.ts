import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AIVIS_ENGINE_URL,
  getAivisEngineTimeoutMs,
  getAivisEngineUrl,
} from './engineConfig';

describe('getAivisEngineUrl', () => {
  it('falls back to the local default so the app works with no .env', () => {
    expect(getAivisEngineUrl({})).toBe(DEFAULT_AIVIS_ENGINE_URL);
    expect(getAivisEngineUrl({ AIVIS_ENGINE_URL: '   ' })).toBe(DEFAULT_AIVIS_ENGINE_URL);
  });

  it('uses AIVIS_ENGINE_URL when set', () => {
    expect(getAivisEngineUrl({ AIVIS_ENGINE_URL: 'http://localhost:20202' })).toBe(
      'http://localhost:20202',
    );
  });
});

describe('getAivisEngineTimeoutMs', () => {
  it('is undefined when unset or not a positive number', () => {
    expect(getAivisEngineTimeoutMs({})).toBeUndefined();
    expect(getAivisEngineTimeoutMs({ AIVIS_ENGINE_TIMEOUT_MS: 'abc' })).toBeUndefined();
    expect(getAivisEngineTimeoutMs({ AIVIS_ENGINE_TIMEOUT_MS: '0' })).toBeUndefined();
  });

  it('parses a positive millisecond value', () => {
    expect(getAivisEngineTimeoutMs({ AIVIS_ENGINE_TIMEOUT_MS: '5000' })).toBe(5000);
  });
});
