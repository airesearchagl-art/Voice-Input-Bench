import { describe, expect, it } from 'vitest';
import { recallCapture, rememberCapture, type CaptureProfiles } from './captureProfile';

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
