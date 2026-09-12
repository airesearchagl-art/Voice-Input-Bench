import { describe, expect, it } from 'vitest';
import {
  PRISTINE_CAPTURE,
  recallCapture,
  rememberCapture,
  resolveCaptureForTool,
  type CaptureProfile,
  type CaptureProfiles,
} from './captureProfile';

/**
 * Per-tool capture metadata, in memory, for this screen only.
 *
 * The transcript never enters it — structurally, there is no field — and one
 * tool's profile never answers for another.
 */

describe('captureProfile', () => {
  it('recalls nothing for a tool that has not been saved', () => {
    expect(recallCapture({}, 'windows-standard-voice-input')).toBeNull();
    expect(recallCapture({ 'aqua-voice': { customToolName: '', toolVersion: '1.4.2', deliveryPath: 'speaker-to-mic' } }, 'windows-standard-voice-input')).toBeNull();
  });

  it('remembers what one save used, without touching the map it was given', () => {
    const before: CaptureProfiles = {};
    const after = rememberCapture(before, 'windows-standard-voice-input', {
      customToolName: '',
      toolVersion: '24H2',
      deliveryPath: 'speaker-to-mic',
    });

    expect(before).toEqual({});
    expect(recallCapture(after, 'windows-standard-voice-input')).toEqual({
      customToolName: '',
      toolVersion: '24H2',
      deliveryPath: 'speaker-to-mic',
    });
  });

  it('keeps tools independent', () => {
    let profiles: CaptureProfiles = {};
    profiles = rememberCapture(profiles, 'windows-standard-voice-input', {
      customToolName: '',
      toolVersion: '24H2',
      deliveryPath: 'speaker-to-mic',
    });
    profiles = rememberCapture(profiles, 'aqua-voice', {
      customToolName: '',
      toolVersion: '1.4.2',
      deliveryPath: 'virtual-audio',
    });
    profiles = rememberCapture(profiles, 'other', {
      customToolName: 'Alpha STT',
      toolVersion: '2.1',
      deliveryPath: 'unknown',
    });

    expect(recallCapture(profiles, 'windows-standard-voice-input')?.toolVersion).toBe('24H2');
    expect(recallCapture(profiles, 'aqua-voice')).toEqual({
      customToolName: '',
      toolVersion: '1.4.2',
      deliveryPath: 'virtual-audio',
    });
    expect(recallCapture(profiles, 'other')?.customToolName).toBe('Alpha STT');
  });

  it('replaces a tool profile on the next save of that tool', () => {
    const first = rememberCapture({}, 'aqua-voice', {
      customToolName: '',
      toolVersion: '1.4.2',
      deliveryPath: 'speaker-to-mic',
    });
    const second = rememberCapture(first, 'aqua-voice', {
      customToolName: '',
      toolVersion: '1.5.0',
      deliveryPath: 'virtual-audio',
    });

    expect(recallCapture(second, 'aqua-voice')).toEqual({
      customToolName: '',
      toolVersion: '1.5.0',
      deliveryPath: 'virtual-audio',
    });
    // The earlier map is a value of its own, not a mutated reference.
    expect(recallCapture(first, 'aqua-voice')?.toolVersion).toBe('1.4.2');
  });

  it('carries only the three capture fields — a transcript has nowhere to go', () => {
    const profiles = rememberCapture({}, 'aqua-voice', {
      customToolName: '',
      toolVersion: '1.4.2',
      deliveryPath: 'speaker-to-mic',
    });
    expect(Object.keys(profiles['aqua-voice']!).sort()).toEqual([
      'customToolName',
      'deliveryPath',
      'toolVersion',
    ]);
  });
});

/**
 * What the form shows after a tool switch.
 *
 * The rule has two branches and no third: the tool's own profile, or the
 * pristine form. Leaving the previous tool's values behind is what let Aqua
 * Voice's version and delivery path be written into a Windows Result.
 */
describe('resolveCaptureForTool', () => {
  const AQUA: CaptureProfile = {
    customToolName: '',
    toolVersion: '1.5',
    deliveryPath: 'virtual-audio',
  };

  it('RF-02-A: gives a tool with no profile the pristine form, not the last tool used', () => {
    const profiles = rememberCapture({}, 'aqua-voice', AQUA);
    const windows = resolveCaptureForTool(profiles, 'windows-standard-voice-input');

    expect(windows).toEqual(PRISTINE_CAPTURE);
    expect(windows.toolVersion).not.toBe('1.5');
    expect(windows.deliveryPath).not.toBe('virtual-audio');
  });

  it('RF-02-B: restores each tool its own profile', () => {
    let profiles = rememberCapture({}, 'aqua-voice', AQUA);
    profiles = rememberCapture(profiles, 'windows-standard-voice-input', {
      customToolName: '',
      toolVersion: '24H2',
      deliveryPath: 'speaker-to-mic',
    });

    // Aqua → Windows → Aqua: each switch answers with that tool's own values.
    expect(resolveCaptureForTool(profiles, 'aqua-voice')).toEqual(AQUA);
    expect(resolveCaptureForTool(profiles, 'windows-standard-voice-input').toolVersion).toBe('24H2');
    expect(resolveCaptureForTool(profiles, 'aqua-voice').toolVersion).toBe('1.5');
  });

  it('RF-02-C: built-in → other carries no cross-tool metadata', () => {
    const profiles = rememberCapture({}, 'aqua-voice', AQUA);
    const other = resolveCaptureForTool(profiles, 'other');

    expect(other).toEqual(PRISTINE_CAPTURE);
    expect(other.customToolName).toBe('');
    expect(other.toolVersion).toBe('');
    expect(other.deliveryPath).toBe('speaker-to-mic');
  });

  it('RF-02-D: a tool stays pristine until a save of that tool records it', () => {
    // recallCapture still reports "nothing saved"; resolve just answers with
    // the pristine form rather than leaving the caller to decide.
    expect(recallCapture({}, 'aqua-voice')).toBeNull();
    expect(resolveCaptureForTool({}, 'aqua-voice')).toEqual(PRISTINE_CAPTURE);

    const after: CaptureProfiles = rememberCapture({}, 'aqua-voice', AQUA);
    expect(resolveCaptureForTool(after, 'aqua-voice')).toEqual(AQUA);
  });
});
