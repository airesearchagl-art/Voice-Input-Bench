import { toCanonicalText } from '@/lib/canonicalText';
import { sha256OfBytes, sha256OfText } from '@/lib/hash';
import { createRunId } from '@/lib/runId';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { concatWav, parseAndValidateSegments } from '@/audio/wav';
import { MANIFEST_SCHEMA_VERSION, type RunManifest } from './manifest';
import { MANUAL_TEST_ID, getBenchmarkCase } from './cases';
import { DEFAULT_TARGET_MAX_CHARS, SPLIT_STRATEGY, splitCanonicalText } from './splitter';
import { TTSProviderError } from '@/tts/TTSProvider';
import type { AivisSpeechProvider, AivmModelSummary } from '@/tts/AivisSpeechProvider';
import type { TTSVoice } from '@/tts/TTSProvider';

/**
 * One Generate → one immutable Run.
 *
 * Everything identifying in the manifest is resolved server-side from fresh
 * engine evidence. The client sends a style ID, two scale values, and either
 * `manual` text or a Benchmark Case ID; it does not get to tell us the speaker
 * name, the model, the engine version, or — for a Case — the text itself. A Run
 * whose identity came from the caller would not be evidence of anything.
 *
 * If identity cannot be pinned down — the style ID is unknown to the engine, or
 * the voice maps to zero or several AIVM models, or the model's UUID/version is
 * missing — no official Run is written. The same holds if any segment fails to
 * synthesize, or if the segments disagree about their audio format. Failing
 * closed keeps `data/runs/` free of Runs that cannot be traced or replayed.
 */

export type BenchmarkErrorKind =
  /** The requested Benchmark Case ID is not a built-in case. */
  | 'CASE_NOT_FOUND'
  /** The requested style ID is not in the engine's current `/speakers`. */
  | 'VOICE_NOT_FOUND'
  /** `/aivm_models` could not be read, so model identity is unavailable. */
  | 'MODEL_EVIDENCE_UNAVAILABLE'
  /** No installed model claims this speaker. */
  | 'MODEL_NOT_FOUND'
  /** Several models claim this speaker; identity is not unique. */
  | 'MODEL_AMBIGUOUS'
  /** The model was found but its UUID, name or version is missing. */
  | 'MODEL_IDENTITY_INCOMPLETE'
  /** The splitter produced nothing to synthesize. */
  | 'NO_SEGMENTS';

export class BenchmarkError extends Error {
  readonly kind: BenchmarkErrorKind;
  readonly detail?: string;

  constructor(kind: BenchmarkErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'BenchmarkError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** Stable shape of `provider-query.json`, one entry per synthesized segment. */
export interface ProviderQueryEnvelope {
  schema_version: 1;
  provider_id: string;
  segments: Array<{
    index: number;
    /** The opaque AudioQuery actually sent to `/synthesis`, unknown fields included. */
    query: unknown;
  }>;
}

export interface GenerateBenchmarkRunInput {
  /** `manual`, or a built-in Benchmark Case ID. */
  testId: string;
  /**
   * Raw text from the UI. Used only when `testId` is `manual`; for a Benchmark
   * Case the server reads its own copy and ignores whatever the client sent.
   */
  rawText: string;
  styleId: number;
  speedScale: number;
  volumeScale: number;
}

export interface GenerateBenchmarkRunDeps {
  provider: AivisSpeechProvider;
  store: LocalRunStore;
  /** Injected in tests so run IDs and timestamps are deterministic. */
  now?: () => Date;
  runId?: string;
  targetMaxChars?: number;
}

export interface GenerateBenchmarkRunResult {
  runId: string;
  runDir: string;
  manifest: RunManifest;
}

/** Resolved model identity, with every field confirmed present. */
interface ResolvedModel {
  uuid: string;
  name: string;
  version: string;
}

/**
 * Resolve the text to synthesize.
 *
 * For a Benchmark Case this reads the server-side source of truth. The client's
 * `rawText` is dropped on the floor: two Runs tagged `architecture-long-001`
 * must contain the same words, or comparing them means nothing.
 */
export function resolveSourceText(testId: string, rawText: string): string {
  if (testId === MANUAL_TEST_ID) return toCanonicalText(rawText);

  const benchmarkCase = getBenchmarkCase(testId);
  if (!benchmarkCase) {
    throw new BenchmarkError('CASE_NOT_FOUND', `Benchmark Case "${testId}" は存在しません。`);
  }
  return toCanonicalText(benchmarkCase.text);
}

function resolveVoice(voices: TTSVoice[], styleId: number): TTSVoice {
  const voice = voices.find((candidate) => candidate.styleId === styleId);
  if (!voice) {
    throw new BenchmarkError(
      'VOICE_NOT_FOUND',
      `style ID ${styleId} は現在の /speakers に存在しません。`,
      `available style ids: ${voices.map((candidate) => candidate.styleId).join(', ') || '(none)'}`,
    );
  }
  return voice;
}

function resolveModel(models: AivmModelSummary[], speakerUuid: string): ResolvedModel {
  const matches = models.filter((model) => model.speakerUuids.includes(speakerUuid));

  if (matches.length === 0) {
    throw new BenchmarkError(
      'MODEL_NOT_FOUND',
      `speaker ${speakerUuid} を提供する AIVM model を特定できませんでした。`,
      `models: ${models.map((model) => model.uuid).join(', ') || '(none)'}`,
    );
  }
  if (matches.length > 1) {
    throw new BenchmarkError(
      'MODEL_AMBIGUOUS',
      `speaker ${speakerUuid} が複数の AIVM model に属しており一意に確定できません。`,
      `candidates: ${matches.map((model) => model.uuid).join(', ')}`,
    );
  }

  const model = matches[0]!;
  const missing = [
    model.uuid ? null : 'uuid',
    model.name ? null : 'name',
    model.version ? null : 'version',
  ].filter((field): field is string => field !== null);

  if (missing.length > 0) {
    throw new BenchmarkError(
      'MODEL_IDENTITY_INCOMPLETE',
      `AIVM model の識別情報が不足しています (${missing.join(', ')})。`,
      `model: ${model.uuid || '(no uuid)'}`,
    );
  }

  return { uuid: model.uuid, name: model.name!, version: model.version! };
}

/** Re-throw a provider failure naming the segment, keeping the original cause category. */
function withSegmentContext(caught: unknown, index: number, total: number): never {
  if (caught instanceof TTSProviderError) {
    throw new TTSProviderError(
      caught.kind,
      caught.providerId,
      `segment ${index + 1}/${total}: ${caught.message}`,
      {
        endpoint: caught.endpoint,
        httpStatus: caught.httpStatus,
        detail: caught.detail,
        cause: caught,
      },
    );
  }
  throw caught;
}

export async function generateBenchmarkRun(
  input: GenerateBenchmarkRunInput,
  deps: GenerateBenchmarkRunDeps,
): Promise<GenerateBenchmarkRunResult> {
  const { provider, store } = deps;
  const now = deps.now ?? (() => new Date());
  const targetMaxChars = deps.targetMaxChars ?? DEFAULT_TARGET_MAX_CHARS;

  // 1. Canonical text, produced once and reused for storage, hashing and TTS.
  const canonicalText = resolveSourceText(input.testId, input.rawText);

  // 2-4. Fresh engine evidence: voice identity, runtime info, model identity.
  //      Read before synthesis so an unidentifiable voice costs nothing.
  const voices = await provider.listVoices();
  const voice = resolveVoice(voices, input.styleId);

  const runtime = await provider.getRuntimeInfo();
  const aivmModels = runtime.providerDetails.aivmModels;
  if (aivmModels.status !== 'ok') {
    throw new BenchmarkError(
      'MODEL_EVIDENCE_UNAVAILABLE',
      '/aivm_models を取得できなかったため model identity を確定できません。',
      aivmModels.error ? `${aivmModels.error.kind}: ${aivmModels.error.message}` : undefined,
    );
  }
  const model = resolveModel(aivmModels.models, voice.speakerUuid);

  // 5. Deterministic split. Segments are slices of the canonical text, so
  //    joining them reproduces it exactly.
  const segments = splitCanonicalText(canonicalText, targetMaxChars);
  if (segments.length === 0) {
    throw new BenchmarkError('NO_SEGMENTS', '合成するテキストがありません。');
  }
  const strategy = segments.length === 1 ? 'none' : SPLIT_STRATEGY;

  // 6. Synthesis, one segment at a time, every segment on the same voice,
  //    style, speed, volume, sample rate and channel count. A failure anywhere
  //    aborts before anything is written.
  const segmentWavs: Uint8Array[] = [];
  const providerQueries: ProviderQueryEnvelope['segments'] = [];

  for (const [index, segmentText] of segments.entries()) {
    try {
      const speech = await provider.generateSpeech({
        text: segmentText,
        styleId: voice.styleId,
        speedScale: input.speedScale,
        volumeScale: input.volumeScale,
      });
      segmentWavs.push(new Uint8Array(speech.audio));
      providerQueries.push({ index, query: speech.providerQuery });
    } catch (caught) {
      withSegmentContext(caught, index, segments.length);
    }
  }

  // 7. Validate then assemble.
  //
  //    Every segment is checked against the Phase 1 audio contract (PCM /
  //    44100 Hz / mono / frame-aligned data) before anything is written. Making
  //    the segments merely agree with each other is not enough: an engine that
  //    returned 48 kHz for all of them would still produce a Run whose manifest
  //    claims 44100.
  //
  //    A single-segment Run is validated and then stored as the engine's
  //    original bytes — never re-encoded or rebuilt. Multi-segment Runs are
  //    stitched from the parsed PCM payloads with nothing inserted and nothing
  //    applied to the samples.
  const parsedSegments = parseAndValidateSegments(segmentWavs);
  const audioBytes = segmentWavs.length === 1 ? segmentWavs[0]! : concatWav(parsedSegments);

  // 8. Hashes, each over the exact bytes that will be on disk.
  const providerQueryEnvelope: ProviderQueryEnvelope = {
    schema_version: 1,
    provider_id: provider.id,
    segments: providerQueries,
  };
  const providerQueryJson = Buffer.from(
    `${JSON.stringify(providerQueryEnvelope, null, 2)}\n`,
    'utf8',
  );

  const generatedAt = now().toISOString();
  const runId = deps.runId ?? createRunId(now());

  // 9. Manifest describes the artifacts by hash, so a later reader can verify
  //    the stored files are the ones this Run was recorded with.
  const manifest: RunManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    test_id: input.testId,
    generated_at: generatedAt,
    source: {
      file: 'source.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
      // The full canonical text, never a segment.
      sha256: sha256OfText(canonicalText),
    },
    provider: {
      id: runtime.providerId,
      engine_name: runtime.engineName,
      engine_version: runtime.engineVersion,
      engine_url: runtime.engineUrl,
    },
    model,
    voice: {
      speaker_uuid: voice.speakerUuid,
      speaker_name: voice.speakerName,
      style_id: voice.styleId,
      style_name: voice.styleName,
    },
    settings: {
      speed_scale: input.speedScale,
      volume_scale: input.volumeScale,
      sample_rate: 44100,
      stereo: false,
    },
    segmentation: {
      strategy,
      target_max_chars: targetMaxChars,
      segment_count: segments.length,
    },
    provider_query: {
      file: 'provider-query.json',
      sha256: sha256OfBytes(providerQueryJson),
    },
    audio: {
      file: 'audio.wav',
      // The stored file is a validated RIFF/WAVE either way. Never inherit a
      // per-segment response header as the assembled file's type.
      content_type: 'audio/wav',
      sha256: sha256OfBytes(audioBytes),
      bytes: audioBytes.byteLength,
    },
    reproducibility: {
      canonical_artifact: true,
      bit_exact_regeneration_expected: false,
    },
  };

  // 10. Transactional write. Nothing under `runId` exists until this succeeds.
  const stored = await store.saveRun(runId, {
    sourceText: canonicalText,
    audio: audioBytes,
    providerQueryJson,
    manifestJson: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  });

  return { runId: stored.runId, runDir: stored.runDir, manifest };
}
