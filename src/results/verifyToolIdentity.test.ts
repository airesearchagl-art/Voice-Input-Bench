import { describe, expect, it } from 'vitest';
import {
  ToolIdentityError,
  trustedToolIdOf,
  verifyStoredToolIdentity,
} from './verifyToolIdentity';

/**
 * The tool / capture / timestamp contract a stored Result must still satisfy.
 * These fields decide which column of a comparison an observation lands in.
 */

const WINDOWS = {
  captured_at: '2026-09-07T02:00:00.000Z',
  tool: { id: 'windows-standard-voice-input', name: 'Windows 標準音声入力', version: '24H2' },
  capture: { method: 'manual-paste', delivery_path: 'speaker-to-mic' },
};

const AQUA = {
  captured_at: '2026-09-07T02:00:00.000Z',
  tool: { id: 'aqua-voice', name: 'Aqua Voice', version: null },
  capture: { method: 'manual-paste', delivery_path: 'virtual-audio' },
};

function withPatch(base: Record<string, unknown>, patch: Record<string, unknown>) {
  return JSON.parse(JSON.stringify({ ...base, ...patch })) as Record<string, unknown>;
}

function expectRejected(stored: Record<string, unknown>, kind: string) {
  let caught: unknown;
  try {
    verifyStoredToolIdentity(stored);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ToolIdentityError);
  expect((caught as ToolIdentityError).kind).toBe(kind);
  expect(trustedToolIdOf(stored)).toBeUndefined();
}

describe('accepts untouched Results', () => {
  it('accepts a Windows observation', () => {
    expect(verifyStoredToolIdentity(WINDOWS)).toEqual({
      id: 'windows-standard-voice-input',
      name: 'Windows 標準音声入力',
      version: '24H2',
      deliveryPath: 'speaker-to-mic',
      capturedAt: '2026-09-07T02:00:00.000Z',
    });
    expect(trustedToolIdOf(WINDOWS)).toBe('windows-standard-voice-input');
  });

  it('accepts an Aqua Voice observation with no version', () => {
    expect(verifyStoredToolIdentity(AQUA).id).toBe('aqua-voice');
    expect(trustedToolIdOf(AQUA)).toBe('aqua-voice');
  });

  it('accepts an `other` tool with a name', () => {
    const other = withPatch(WINDOWS, {
      tool: { id: 'other', name: '社内ツール', version: null },
    });
    expect(verifyStoredToolIdentity(other).id).toBe('other');
    expect(trustedToolIdOf(other)).toBe('other');
  });

  it('accepts every known delivery path', () => {
    for (const deliveryPath of ['speaker-to-mic', 'virtual-audio', 'other', 'unknown']) {
      const stored = withPatch(WINDOWS, {
        capture: { method: 'manual-paste', delivery_path: deliveryPath },
      });
      expect(verifyStoredToolIdentity(stored).deliveryPath).toBe(deliveryPath);
    }
  });
});

describe('tool contract', () => {
  it('rejects an unknown tool id', () => {
    expectRejected(
      withPatch(WINDOWS, { tool: { id: 'whisper', name: 'Whisper', version: null } }),
      'RESULT_TOOL_CONTRACT_MISMATCH',
    );
  });

  it('rejects a missing tool section', () => {
    expectRejected(withPatch(WINDOWS, { tool: undefined }), 'RESULT_TOOL_CONTRACT_MISMATCH');
  });

  it('rejects the Windows id carrying the Aqua Voice name', () => {
    expectRejected(
      withPatch(WINDOWS, {
        tool: { id: 'windows-standard-voice-input', name: 'Aqua Voice', version: null },
      }),
      'RESULT_TOOL_CONTRACT_MISMATCH',
    );
  });

  it('rejects the Aqua id carrying the Windows name', () => {
    expectRejected(
      withPatch(WINDOWS, {
        tool: { id: 'aqua-voice', name: 'Windows 標準音声入力', version: null },
      }),
      'RESULT_TOOL_CONTRACT_MISMATCH',
    );
  });

  it('rejects `other` with a blank name', () => {
    for (const name of ['', '   ']) {
      expectRejected(
        withPatch(WINDOWS, { tool: { id: 'other', name, version: null } }),
        'RESULT_TOOL_CONTRACT_MISMATCH',
      );
    }
  });

  it('rejects a non-string tool name', () => {
    expectRejected(
      withPatch(WINDOWS, { tool: { id: 'aqua-voice', name: 42, version: null } }),
      'RESULT_TOOL_CONTRACT_MISMATCH',
    );
  });

  const BAD_VERSIONS: unknown[] = [42, true, [], {}, '', '  1.4.2  ', '1.4.2 '];

  for (const version of BAD_VERSIONS) {
    it(`rejects tool.version ${JSON.stringify(version)}`, () => {
      expectRejected(
        withPatch(WINDOWS, {
          tool: { id: 'aqua-voice', name: 'Aqua Voice', version },
        }),
        'RESULT_TOOL_CONTRACT_MISMATCH',
      );
    });
  }
});

describe('capture contract', () => {
  it('rejects a tampered capture method', () => {
    expectRejected(
      withPatch(WINDOWS, { capture: { method: 'automated', delivery_path: 'speaker-to-mic' } }),
      'RESULT_CAPTURE_CONTRACT_MISMATCH',
    );
  });

  it('rejects an unknown delivery path', () => {
    expectRejected(
      withPatch(WINDOWS, { capture: { method: 'manual-paste', delivery_path: 'bluetooth' } }),
      'RESULT_CAPTURE_CONTRACT_MISMATCH',
    );
  });

  it('rejects a missing capture section', () => {
    expectRejected(withPatch(WINDOWS, { capture: undefined }), 'RESULT_CAPTURE_CONTRACT_MISMATCH');
  });
});

describe('captured_at contract', () => {
  const BAD: unknown[] = ['not a date', '', 42, null, undefined];

  for (const capturedAt of BAD) {
    it(`rejects captured_at ${JSON.stringify(capturedAt)}`, () => {
      expectRejected(withPatch(WINDOWS, { captured_at: capturedAt }), 'RESULT_CAPTURED_AT_INVALID');
    });
  }
});

describe('trustedToolIdOf', () => {
  it('is undefined for anything that is not an object', () => {
    for (const value of [null, undefined, 42, 'x', []]) {
      expect(trustedToolIdOf(value)).toBeUndefined();
    }
  });
});
