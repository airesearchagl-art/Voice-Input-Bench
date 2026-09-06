import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_TOOL_NAMES,
  DELIVERY_PATHS,
  STT_TOOL_IDS,
  ToolResolutionError,
  isDeliveryPath,
  isSttToolId,
  resolveDeliveryPath,
  resolveTool,
} from './tools';

describe('tool registry', () => {
  it('ships exactly the built-in tool IDs', () => {
    expect([...STT_TOOL_IDS]).toEqual(['windows-standard-voice-input', 'aqua-voice', 'other']);
  });

  it('recognizes only those IDs', () => {
    for (const id of STT_TOOL_IDS) expect(isSttToolId(id)).toBe(true);
    for (const value of ['whisper', '', null, undefined, 42, 'WINDOWS-STANDARD-VOICE-INPUT']) {
      expect(isSttToolId(value)).toBe(false);
    }
  });

  it('owns the display name of every built-in tool', () => {
    expect(BUILT_IN_TOOL_NAMES['windows-standard-voice-input']).toBe('Windows 標準音声入力');
    expect(BUILT_IN_TOOL_NAMES['aqua-voice']).toBe('Aqua Voice');
  });
});

describe('resolveTool', () => {
  it('uses the server-side name for a built-in tool', () => {
    expect(resolveTool({ toolId: 'windows-standard-voice-input' })).toEqual({
      id: 'windows-standard-voice-input',
      name: 'Windows 標準音声入力',
      version: null,
    });
    expect(resolveTool({ toolId: 'aqua-voice' })).toEqual({
      id: 'aqua-voice',
      name: 'Aqua Voice',
      version: null,
    });
  });

  it('keeps a supplied version as free text', () => {
    expect(resolveTool({ toolId: 'aqua-voice', toolVersion: '  1.4.2  ' }).version).toBe('1.4.2');
  });

  it('treats an absent or blank version as null', () => {
    for (const toolVersion of [undefined, null, '', '   ']) {
      expect(resolveTool({ toolId: 'aqua-voice', toolVersion }).version).toBeNull();
    }
  });

  it('takes a custom name only for `other`', () => {
    expect(resolveTool({ toolId: 'other', customToolName: '  社内ツール  ' })).toEqual({
      id: 'other',
      name: '社内ツール',
      version: null,
    });
  });

  it('refuses `other` without a name', () => {
    for (const customToolName of [undefined, null, '', '   ']) {
      let caught: unknown;
      try {
        resolveTool({ toolId: 'other', customToolName });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ToolResolutionError);
      expect((caught as ToolResolutionError).kind).toBe('CUSTOM_TOOL_NAME_REQUIRED');
    }
  });

  it('refuses a custom name for a tool whose name the server owns', () => {
    // Letting the caller rename a built-in tool would make two Results claiming
    // the same tool ID carry different names.
    for (const toolId of ['windows-standard-voice-input', 'aqua-voice']) {
      let caught: unknown;
      try {
        resolveTool({ toolId, customToolName: 'なりすまし' });
      } catch (error) {
        caught = error;
      }
      expect((caught as ToolResolutionError).kind).toBe('CUSTOM_TOOL_NAME_NOT_ALLOWED');
    }
  });

  it('ignores a blank custom name on a built-in tool', () => {
    expect(resolveTool({ toolId: 'aqua-voice', customToolName: '   ' }).name).toBe('Aqua Voice');
  });

  it('refuses an unknown tool ID', () => {
    for (const toolId of ['whisper', '', null, 7]) {
      let caught: unknown;
      try {
        resolveTool({ toolId });
      } catch (error) {
        caught = error;
      }
      expect((caught as ToolResolutionError).kind).toBe('UNKNOWN_TOOL_ID');
    }
  });
});

describe('delivery path', () => {
  it('accepts exactly the known paths', () => {
    expect([...DELIVERY_PATHS]).toEqual(['speaker-to-mic', 'virtual-audio', 'other', 'unknown']);
    for (const value of DELIVERY_PATHS) {
      expect(isDeliveryPath(value)).toBe(true);
      expect(resolveDeliveryPath(value)).toBe(value);
    }
  });

  it('refuses anything else', () => {
    for (const value of ['bluetooth', '', null, undefined, 3, 'SPEAKER-TO-MIC']) {
      expect(isDeliveryPath(value)).toBe(false);
      let caught: unknown;
      try {
        resolveDeliveryPath(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ToolResolutionError);
      expect((caught as ToolResolutionError).kind).toBe('UNKNOWN_DELIVERY_PATH');
    }
  });
});
