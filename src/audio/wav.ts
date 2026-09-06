/**
 * Minimal RIFF/WAVE reading and concatenation.
 *
 * Assembly is byte surgery only: the PCM payloads of the segments are placed
 * end to end and a fresh RIFF header is written around them, reusing the first
 * segment's `fmt ` chunk verbatim. Nothing is added between segments and
 * nothing is applied to the samples — no inserted silence, no normalization,
 * no denoise, no silence trimming, no resampling, no gain.
 *
 * Any disagreement between segments about the audio format is a Fail Closed
 * condition: concatenating PCM of two different formats would produce a file
 * that plays as noise while still looking like a valid Run.
 */

export type WavErrorKind =
  /** Not a RIFF/WAVE container. */
  | 'NOT_RIFF_WAVE'
  /** A chunk header or body runs past the end of the buffer. */
  | 'TRUNCATED_CHUNK'
  /** No `fmt ` chunk, or it is too short to read. */
  | 'MISSING_FMT'
  /** No `data` chunk. */
  | 'MISSING_DATA'
  /** The data chunk is not a whole number of frames. */
  | 'DATA_NOT_FRAME_ALIGNED'
  /** Not linear PCM. Phase 1 does not attempt to handle other encodings. */
  | 'UNSUPPORTED_AUDIO_FORMAT'
  /** Sample rate is not the Phase 1 fixed 44100 Hz. */
  | 'UNEXPECTED_SAMPLE_RATE'
  /** Channel count is not the Phase 1 fixed mono. */
  | 'UNEXPECTED_CHANNEL_COUNT'
  /** Segments disagree on format / channels / sample rate / bit depth. */
  | 'FORMAT_MISMATCH'
  /** Nothing to assemble. */
  | 'NO_SEGMENT_WAVS';

/**
 * The audio contract Phase 1 asks the engine for and therefore the only shape a
 * Run may store.
 *
 * Checking segments against each other is not enough: if the engine ignored the
 * request and returned 48 kHz stereo for every segment, they would agree with
 * one another and a Run would be written claiming 44100/mono in its manifest.
 * So each segment is checked against these values, not against its neighbours.
 */
export const PHASE1_AUDIO_CONTRACT = {
  /** WAVE_FORMAT_PCM. */
  audioFormat: 1,
  sampleRate: 44100,
  channels: 1,
} as const;

export class WavError extends Error {
  readonly kind: WavErrorKind;
  readonly detail?: string;

  constructor(kind: WavErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'WavError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface WavFormat {
  /** 1 = PCM, 0xFFFE = extensible, etc. Compared, never rewritten. */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export interface ParsedWav {
  format: WavFormat;
  /** Raw `fmt ` chunk body, preserved so assembly does not re-derive it. */
  fmtChunk: Uint8Array;
  /** Raw `data` chunk body. */
  data: Uint8Array;
}

const RIFF = 'RIFF';
const WAVE = 'WAVE';
const FMT_ID = 'fmt ';
const DATA_ID = 'data';

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}

/** Parse a WAV container, walking the chunk list rather than assuming a 44-byte header. */
export function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.byteLength < 12) {
    throw new WavError('NOT_RIFF_WAVE', 'WAV が短すぎます。', `byteLength=${bytes.byteLength}`);
  }
  if (readAscii(bytes, 0, 4) !== RIFF || readAscii(bytes, 8, 4) !== WAVE) {
    throw new WavError('NOT_RIFF_WAVE', 'RIFF/WAVE ヘッダではありません。');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let fmtChunk: Uint8Array | null = null;
  let data: Uint8Array | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;

    if (bodyStart + size > bytes.byteLength) {
      throw new WavError(
        'TRUNCATED_CHUNK',
        `チャンク "${id}" がバッファの終端を越えています。`,
        `offset=${offset} size=${size} byteLength=${bytes.byteLength}`,
      );
    }

    if (id === FMT_ID && !fmtChunk) fmtChunk = bytes.subarray(bodyStart, bodyStart + size);
    if (id === DATA_ID && !data) data = bytes.subarray(bodyStart, bodyStart + size);

    // RIFF chunks are padded to an even length; the pad byte is not counted.
    offset = bodyStart + size + (size % 2);
  }

  if (!fmtChunk || fmtChunk.byteLength < 16) {
    throw new WavError('MISSING_FMT', 'fmt チャンクがないか短すぎます。');
  }
  if (!data) {
    throw new WavError('MISSING_DATA', 'data チャンクがありません。');
  }

  const fmtView = new DataView(fmtChunk.buffer, fmtChunk.byteOffset, fmtChunk.byteLength);
  const format: WavFormat = {
    audioFormat: fmtView.getUint16(0, true),
    channels: fmtView.getUint16(2, true),
    sampleRate: fmtView.getUint32(4, true),
    byteRate: fmtView.getUint32(8, true),
    blockAlign: fmtView.getUint16(12, true),
    bitsPerSample: fmtView.getUint16(14, true),
  };

  if (format.blockAlign > 0 && data.byteLength % format.blockAlign !== 0) {
    throw new WavError(
      'DATA_NOT_FRAME_ALIGNED',
      'data チャンクがフレーム境界で終わっていません。',
      `dataBytes=${data.byteLength} blockAlign=${format.blockAlign}`,
    );
  }

  return { format, fmtChunk, data };
}

function describeFormat(format: WavFormat): string {
  return `format=${format.audioFormat} channels=${format.channels} sampleRate=${format.sampleRate} bits=${format.bitsPerSample} blockAlign=${format.blockAlign}`;
}

/** Every field that must agree before two payloads may be placed end to end. */
function assertSameFormat(first: WavFormat, other: WavFormat, index: number): void {
  const differs =
    first.audioFormat !== other.audioFormat ||
    first.channels !== other.channels ||
    first.sampleRate !== other.sampleRate ||
    first.bitsPerSample !== other.bitsPerSample ||
    first.blockAlign !== other.blockAlign;

  if (differs) {
    throw new WavError(
      'FORMAT_MISMATCH',
      `segment ${index} の WAV フォーマットが segment 0 と一致しません。`,
      `segment0: ${describeFormat(first)} / segment${index}: ${describeFormat(other)}`,
    );
  }
}

/**
 * Concatenate parsed WAVs into one container.
 *
 * The output is `RIFF` + `fmt ` (copied from the first segment) + `data`
 * (the segment payloads, in order, with nothing between them).
 */
export function concatWav(parts: readonly ParsedWav[]): Uint8Array {
  if (parts.length === 0) {
    throw new WavError('NO_SEGMENT_WAVS', '結合する WAV がありません。');
  }

  const first = parts[0]!;
  parts.forEach((part, index) => {
    if (index > 0) assertSameFormat(first.format, part.format, index);
  });

  const fmtBody = first.fmtChunk;
  const fmtPad = fmtBody.byteLength % 2;
  const dataLength = parts.reduce((total, part) => total + part.data.byteLength, 0);
  const dataPad = dataLength % 2;

  // "WAVE" + fmt header/body/pad + data header/body/pad
  const riffSize = 4 + (8 + fmtBody.byteLength + fmtPad) + (8 + dataLength + dataPad);
  const out = new Uint8Array(8 + riffSize);
  const view = new DataView(out.buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, RIFF);
  view.setUint32(4, riffSize, true);
  writeAscii(8, WAVE);

  let offset = 12;
  writeAscii(offset, FMT_ID);
  view.setUint32(offset + 4, fmtBody.byteLength, true);
  out.set(fmtBody, offset + 8);
  offset += 8 + fmtBody.byteLength + fmtPad;

  writeAscii(offset, DATA_ID);
  view.setUint32(offset + 4, dataLength, true);
  offset += 8;
  for (const part of parts) {
    out.set(part.data, offset);
    offset += part.data.byteLength;
  }

  return out;
}

/**
 * Check one segment against {@link PHASE1_AUDIO_CONTRACT}.
 *
 * `segmentLabel` names the segment in the error so a failure points at which of
 * a long Run's pieces came back wrong.
 */
export function assertPhase1AudioContract(parsed: ParsedWav, segmentLabel: string): void {
  const { format } = parsed;

  if (format.audioFormat !== PHASE1_AUDIO_CONTRACT.audioFormat) {
    throw new WavError(
      'UNSUPPORTED_AUDIO_FORMAT',
      `${segmentLabel} が PCM ではありません。Phase 1 は linear PCM のみを扱います。`,
      `audioFormat=${format.audioFormat} (expected ${PHASE1_AUDIO_CONTRACT.audioFormat})`,
    );
  }
  if (format.sampleRate !== PHASE1_AUDIO_CONTRACT.sampleRate) {
    throw new WavError(
      'UNEXPECTED_SAMPLE_RATE',
      `${segmentLabel} のサンプルレートが ${PHASE1_AUDIO_CONTRACT.sampleRate} Hz ではありません。`,
      `sampleRate=${format.sampleRate} (expected ${PHASE1_AUDIO_CONTRACT.sampleRate})`,
    );
  }
  if (format.channels !== PHASE1_AUDIO_CONTRACT.channels) {
    throw new WavError(
      'UNEXPECTED_CHANNEL_COUNT',
      `${segmentLabel} がモノラルではありません。`,
      `channels=${format.channels} (expected ${PHASE1_AUDIO_CONTRACT.channels})`,
    );
  }
}

/**
 * Parse every segment and check each one against the Phase 1 contract.
 *
 * Runs on single-segment Runs too. The caller decides what to store: a
 * single-segment Run keeps the engine's original bytes, it is only validated
 * here, never re-encoded or rebuilt.
 */
export function parseAndValidateSegments(segmentWavs: readonly Uint8Array[]): ParsedWav[] {
  if (segmentWavs.length === 0) {
    throw new WavError('NO_SEGMENT_WAVS', '検証する WAV がありません。');
  }

  return segmentWavs.map((bytes, index) => {
    const label =
      segmentWavs.length === 1 ? 'WAV' : `segment ${index + 1}/${segmentWavs.length} の WAV`;
    let parsed: ParsedWav;
    try {
      parsed = parseWav(bytes);
    } catch (caught) {
      if (caught instanceof WavError) {
        throw new WavError(caught.kind, `${label}: ${caught.message}`, caught.detail);
      }
      throw caught;
    }
    assertPhase1AudioContract(parsed, label);
    return parsed;
  });
}

/** Parse, validate against the Phase 1 contract, then concatenate. */
export function assembleSegmentWavs(segmentWavs: readonly Uint8Array[]): Uint8Array {
  return concatWav(parseAndValidateSegments(segmentWavs));
}
