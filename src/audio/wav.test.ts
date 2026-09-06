import { describe, expect, it } from 'vitest';
import { WavError, assembleSegmentWavs, concatWav, parseWav } from './wav';

/**
 * Build a WAV container by hand so the tests exercise the real chunk walk
 * rather than a fixture produced by the same code under test.
 */
interface BuildOptions {
  audioFormat?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  data: Uint8Array;
  /** Extra chunks inserted before `data`, e.g. a LIST chunk. */
  extraChunks?: Array<{ id: string; body: Uint8Array }>;
  /** Deliberately wrong data chunk size, for truncation tests. */
  overrideDataSize?: number;
}

function buildWav(options: BuildOptions): Uint8Array {
  const audioFormat = options.audioFormat ?? 1;
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 44100;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const fmtBody = new Uint8Array(16);
  const fmtView = new DataView(fmtBody.buffer);
  fmtView.setUint16(0, audioFormat, true);
  fmtView.setUint16(2, channels, true);
  fmtView.setUint32(4, sampleRate, true);
  fmtView.setUint32(8, byteRate, true);
  fmtView.setUint16(12, blockAlign, true);
  fmtView.setUint16(14, bitsPerSample, true);

  const chunks: Array<{ id: string; body: Uint8Array; declaredSize?: number }> = [
    { id: 'fmt ', body: fmtBody },
    ...(options.extraChunks ?? []),
    { id: 'data', body: options.data, declaredSize: options.overrideDataSize },
  ];

  let bodySize = 4; // "WAVE"
  for (const chunk of chunks) bodySize += 8 + chunk.body.byteLength + (chunk.body.byteLength % 2);

  const out = new Uint8Array(8 + bodySize);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, bodySize, true);
  writeAscii(8, 'WAVE');

  let offset = 12;
  for (const chunk of chunks) {
    writeAscii(offset, chunk.id);
    view.setUint32(offset + 4, chunk.declaredSize ?? chunk.body.byteLength, true);
    out.set(chunk.body, offset + 8);
    offset += 8 + chunk.body.byteLength + (chunk.body.byteLength % 2);
  }

  return out;
}

/** Deterministic 16-bit PCM payload. */
function pcm(frames: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(frames * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i += 1) view.setInt16(i * 2, ((seed + i) % 3000) - 1500, true);
  return bytes;
}

describe('parseWav', () => {
  it('reads fmt and data from a minimal container', () => {
    const data = pcm(100, 1);
    const parsed = parseWav(buildWav({ data }));

    expect(parsed.format).toEqual({
      audioFormat: 1,
      channels: 1,
      sampleRate: 44100,
      byteRate: 88200,
      blockAlign: 2,
      bitsPerSample: 16,
    });
    expect(new Uint8Array(parsed.data)).toEqual(data);
  });

  it('walks past unknown chunks instead of assuming a 44-byte header', () => {
    const data = pcm(50, 7);
    const parsed = parseWav(
      buildWav({ data, extraChunks: [{ id: 'LIST', body: new Uint8Array([1, 2, 3, 4]) }] }),
    );
    expect(new Uint8Array(parsed.data)).toEqual(data);
  });

  it('honours the pad byte after an odd-sized chunk', () => {
    // A 3-byte LIST chunk is padded to 4; miscounting it would land the reader
    // in the middle of the data header.
    const data = pcm(40, 11);
    const parsed = parseWav(
      buildWav({ data, extraChunks: [{ id: 'LIST', body: new Uint8Array([9, 9, 9]) }] }),
    );
    expect(new Uint8Array(parsed.data)).toEqual(data);
  });

  const REJECTED: Array<[string, () => Uint8Array, string]> = [
    ['a buffer that is too short', () => new Uint8Array(4), 'NOT_RIFF_WAVE'],
    [
      'a non-RIFF container',
      () => {
        const bytes = buildWav({ data: pcm(10, 1) });
        bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
        return bytes;
      },
      'NOT_RIFF_WAVE',
    ],
    [
      'a non-WAVE RIFF',
      () => {
        const bytes = buildWav({ data: pcm(10, 1) });
        bytes.set([0x41, 0x56, 0x49, 0x20], 8); // "AVI "
        return bytes;
      },
      'NOT_RIFF_WAVE',
    ],
    [
      'a chunk that runs past the end',
      () => buildWav({ data: pcm(10, 1), overrideDataSize: 9999 }),
      'TRUNCATED_CHUNK',
    ],
    [
      'a container with no data chunk',
      () => {
        const bytes = buildWav({ data: pcm(10, 1) });
        // Rename "data" to "junk" so the chunk walk finds no payload.
        const index = bytes.indexOf(0x64); // 'd'
        bytes.set([0x6a, 0x75, 0x6e, 0x6b], index); // "junk"
        return bytes;
      },
      'MISSING_DATA',
    ],
    [
      'a data chunk that is not frame aligned',
      () => buildWav({ data: new Uint8Array(11), channels: 1, bitsPerSample: 16 }),
      'DATA_NOT_FRAME_ALIGNED',
    ],
  ];

  for (const [label, build, kind] of REJECTED) {
    it(`rejects ${label} as ${kind}`, () => {
      let caught: unknown;
      try {
        parseWav(build());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WavError);
      expect((caught as WavError).kind).toBe(kind);
    });
  }
});

describe('concatWav', () => {
  it('places the PCM payloads end to end with nothing between them', () => {
    const a = pcm(100, 1);
    const b = pcm(60, 500);
    const c = pcm(20, 900);

    const out = assembleSegmentWavs([
      buildWav({ data: a }),
      buildWav({ data: b }),
      buildWav({ data: c }),
    ]);
    const parsed = parseWav(out);

    const expected = new Uint8Array(a.byteLength + b.byteLength + c.byteLength);
    expected.set(a, 0);
    expected.set(b, a.byteLength);
    expected.set(c, a.byteLength + b.byteLength);

    expect(new Uint8Array(parsed.data)).toEqual(expected);
    expect(parsed.data.byteLength).toBe(a.byteLength + b.byteLength + c.byteLength);
  });

  it('adds no silence, gain, resampling or trimming', () => {
    const a = pcm(64, 3);
    const b = pcm(64, 4);
    const parsed = parseWav(assembleSegmentWavs([buildWav({ data: a }), buildWav({ data: b })]));

    // Byte-for-byte: the first half is segment a, the second is segment b.
    expect(new Uint8Array(parsed.data.subarray(0, a.byteLength))).toEqual(a);
    expect(new Uint8Array(parsed.data.subarray(a.byteLength))).toEqual(b);
    expect(parsed.format.sampleRate).toBe(44100);
  });

  it('writes a RIFF size and data size that match the assembled bytes', () => {
    const out = assembleSegmentWavs([
      buildWav({ data: pcm(100, 1) }),
      buildWav({ data: pcm(100, 2) }),
    ]);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

    expect(String.fromCharCode(...out.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...out.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(out.byteLength - 8);

    // fmt is 16 bytes, so data's header sits at 12 + 8 + 16.
    expect(String.fromCharCode(...out.subarray(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(400);
    expect(out.byteLength).toBe(44 + 400);
  });

  it('preserves the first segment fmt chunk verbatim', () => {
    const first = buildWav({ data: pcm(10, 1), sampleRate: 44100, channels: 1 });
    const parsedFirst = parseWav(first);
    const parsedOut = parseWav(assembleSegmentWavs([first, buildWav({ data: pcm(10, 2) })]));
    expect(new Uint8Array(parsedOut.fmtChunk)).toEqual(new Uint8Array(parsedFirst.fmtChunk));
  });

  it('round-trips a single segment through parse and concat', () => {
    const data = pcm(128, 5);
    const parsed = parseWav(assembleSegmentWavs([buildWav({ data })]));
    expect(new Uint8Array(parsed.data)).toEqual(data);
  });

  const MISMATCHES: Array<[string, BuildOptions]> = [
    ['sample rate', { data: pcm(10, 2), sampleRate: 48000 }],
    ['channel count', { data: pcm(10, 2), channels: 2 }],
    ['bit depth', { data: pcm(10, 2), bitsPerSample: 8 }],
    ['audio format', { data: pcm(10, 2), audioFormat: 3 }],
  ];

  for (const [label, options] of MISMATCHES) {
    it(`fails closed when segments disagree on ${label}`, () => {
      let caught: unknown;
      try {
        assembleSegmentWavs([buildWav({ data: pcm(10, 1) }), buildWav(options)]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WavError);
      expect((caught as WavError).kind).toBe('FORMAT_MISMATCH');
      expect((caught as WavError).detail).toContain('segment0');
    });
  }

  it('fails closed when there is nothing to assemble', () => {
    expect(() => concatWav([])).toThrow(WavError);
  });

  it('fails closed when one segment is not a WAV at all', () => {
    expect(() =>
      assembleSegmentWavs([buildWav({ data: pcm(10, 1) }), new Uint8Array([1, 2, 3, 4])]),
    ).toThrow(WavError);
  });
});
