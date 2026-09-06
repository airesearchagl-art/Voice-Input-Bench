import { toCanonicalText } from '@/lib/canonicalText';
import { sha256OfBytes, sha256OfText } from '@/lib/hash';
import { createRunId } from '@/lib/runId';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { MANIFEST_SCHEMA_VERSION, type RunManifestV1 } from './manifest';
import type { AivisSpeechProvider, AivmModelSummary } from '@/tts/AivisSpeechProvider';
import type { TTSVoice } from '@/tts/TTSProvider';

/**
 * One Generate → one immutable Run.
 *
 * Everything identifying in the manifest is resolved server-side from fresh
 * engine evidence. The client sends a style ID and two scale values; it does
 * not get to tell us the speaker name, the model, or the engine version. A
 * Run whose identity came from the caller would not be evidence of anything.
 *
 * If identity cannot be pinned down — the style ID is unknown to the engine,
 * or the voice maps to zero or several AIVM models, or the model's UUID/version
 * is missing — no official Run is written. Failing closed keeps `data/runs/`
 * free of Runs that cannot be traced back to a specific model build.
 */

export type BenchmarkErrorKind =
  /** The requested style ID is not in the engine's current `/speakers`. */
  | 'VOICE_NOT_FOUND'
  /** `/aivm_models` could not be read, so model identity is unavailable. */
  | 'MODEL_EVIDENCE_UNAVAILABLE'
  /** No installed model claims this speaker. */
  | 'MODEL_NOT_FOUND'
  /** Several models claim this speaker; identity is not unique. */
  | 'MODEL_AMBIGUOUS'
  /** The model was found but its UUID, name or version is missing. */
  | 'MODEL_IDENTITY_INCOMPLETE';

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

export interface GenerateBenchmarkRunInput {
  /** Raw text straight from the UI. Canonicalized here, once. */
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
}

export interface GenerateBenchmarkRunResult {
  runId: string;
  runDir: string;
  manifest: RunManifestV1;
}

/** Resolved model identity, with every field confirmed present. */
interface ResolvedModel {
  uuid: string;
  name: string;
  version: string;
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

export async function generateBenchmarkRun(
  input: GenerateBenchmarkRunInput,
  deps: GenerateBenchmarkRunDeps,
): Promise<GenerateBenchmarkRunResult> {
  const { provider, store } = deps;
  const now = deps.now ?? (() => new Date());

  // 1. Canonical text, produced once and reused for storage, hashing and TTS.
  const canonicalText = toCanonicalText(input.rawText);

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

  // 5-6. Synthesis. The canonical string — untrimmed — is what goes to the engine.
  const speech = await provider.generateSpeech({
    text: canonicalText,
    styleId: voice.styleId,
    speedScale: input.speedScale,
    volumeScale: input.volumeScale,
  });

  // 7. Hashes, each over the exact bytes that will be on disk.
  const audioBytes = new Uint8Array(speech.audio);
  const providerQueryJson = Buffer.from(
    `${JSON.stringify(speech.providerQuery, null, 2)}\n`,
    'utf8',
  );

  const generatedAt = now().toISOString();
  const runId = deps.runId ?? createRunId(now());

  // 8. Manifest describes the artifacts by hash, so a later reader can verify
  //    the stored files are the ones this Run was recorded with.
  const manifest: RunManifestV1 = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    test_id: 'manual',
    generated_at: generatedAt,
    source: {
      file: 'source.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
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
      strategy: 'none',
      segment_count: 1,
    },
    provider_query: {
      file: 'provider-query.json',
      sha256: sha256OfBytes(providerQueryJson),
    },
    audio: {
      file: 'audio.wav',
      content_type: speech.contentType,
      sha256: sha256OfBytes(audioBytes),
      bytes: audioBytes.byteLength,
    },
    reproducibility: {
      canonical_artifact: true,
      bit_exact_regeneration_expected: false,
    },
  };

  // 9. Transactional write. Nothing under `runId` exists until this succeeds.
  const stored = await store.saveRun(runId, {
    sourceText: canonicalText,
    audio: audioBytes,
    providerQueryJson,
    manifestJson: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  });

  return { runId: stored.runId, runDir: stored.runDir, manifest };
}
