import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { RunEvidenceError, listVerifiableRuns, verifyRunEvidence } from './runEvidence';
import { listResultsForRun, saveManualSttResult } from './saveResult';
import { ToolResolutionError } from './tools';

/**
 * Result capture against real Run Bundles on disk. Phase 1 Runs are written
 * here with the same store Phase 1 uses, then verified and cited — never
 * modified.
 */

const RUN_ID = '20260906T011343123Z-aabbccdd';
const OTHER_RUN_ID = '20260906T011344000Z-11223344';
const RESULT_ID = '20260906T020000000Z-deadbeef';
const RESULT_ID_2 = '20260906T020001000Z-cafebabe';
const NOW = new Date('2026-09-06T02:00:00.000Z');

const SOURCE_TEXT = '基準階の会議室は north side に寄せてください。';
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 9, 9]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

interface RunOverrides {
  schemaVersion?: unknown;
  testId?: string;
  /** Corrupt one manifest hash to simulate drift. */
  audioSha256?: string;
  /** Drop a top-level manifest section. */
  omit?: 'source' | 'audio' | 'provider_query' | 'segmentation' | 'voice';
}

function manifestFor(runId: string, overrides: RunOverrides = {}): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    schema_version: overrides.schemaVersion ?? 2,
    run_id: runId,
    test_id: overrides.testId ?? 'architecture-short-001',
    generated_at: NOW.toISOString(),
    source: { file: 'source.txt', encoding: 'utf-8', line_endings: 'lf', sha256: sha(SOURCE_TEXT) },
    provider: {
      id: 'aivisspeech',
      engine_name: 'AivisSpeech',
      engine_version: '1.1.0-dev',
      engine_url: 'http://127.0.0.1:10101',
    },
    model: { uuid: 'model-1', name: 'まお', version: '1.2.0' },
    voice: {
      speaker_uuid: 'speaker-1',
      speaker_name: 'まお',
      style_id: 888753760,
      style_name: 'ノーマル',
    },
    settings: { speed_scale: 1, volume_scale: 1, sample_rate: 44100, stereo: false },
    segmentation: { strategy: 'none', target_max_chars: 450, segment_count: 1 },
    provider_query: { file: 'provider-query.json', sha256: sha(PROVIDER_QUERY) },
    audio: {
      file: 'audio.wav',
      content_type: 'audio/wav',
      sha256: overrides.audioSha256 ?? sha(AUDIO),
      bytes: AUDIO.byteLength,
    },
    reproducibility: { canonical_artifact: true, bit_exact_regeneration_expected: false },
  };
  if (overrides.omit) delete manifest[overrides.omit];
  return manifest;
}

let runsRoot: string;
let resultsRoot: string;
let runStore: LocalRunStore;
let resultStore: LocalResultStore;

async function writeRun(runId = RUN_ID, overrides: RunOverrides = {}): Promise<void> {
  await runStore.saveRun(runId, {
    sourceText: SOURCE_TEXT,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifestFor(runId, overrides), null, 2)}\n`, 'utf8'),
  });
}

/** Every Run Bundle file with its current hash, for before/after comparison. */
async function runFingerprint(runId: string): Promise<Record<string, string>> {
  const dir = runStore.resolveRunDir(runId);
  const files = (await readdir(dir)).sort();
  const out: Record<string, string> = {};
  for (const file of files) out[file] = sha(new Uint8Array(await readFile(path.join(dir, file))));
  return out;
}

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-p2-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-p2-results-'));
  runStore = new LocalRunStore(runsRoot);
  resultStore = new LocalResultStore(resultsRoot);
});

afterEach(async () => {
  await rm(runsRoot, { recursive: true, force: true });
  await rm(resultsRoot, { recursive: true, force: true });
});

const INPUT = {
  runId: RUN_ID,
  toolId: 'windows-standard-voice-input',
  deliveryPath: 'speaker-to-mic',
  rawTranscript: '基準階の会議室は north side に寄せてください。',
};

describe('run evidence verification', () => {
  it('accepts a schema v2 Run whose files still match its manifest', async () => {
    await writeRun();
    const evidence = await verifyRunEvidence(runStore, RUN_ID);

    expect(evidence).toMatchObject({
      runId: RUN_ID,
      manifestSchemaVersion: 2,
      testId: 'architecture-short-001',
      sourceSha256: sha(SOURCE_TEXT),
      audioSha256: sha(AUDIO),
      providerQuerySha256: sha(PROVIDER_QUERY),
    });
  });

  it('refuses a Run that does not exist', async () => {
    const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunEvidenceError);
    expect((error as RunEvidenceError).kind).toBe('RUN_NOT_FOUND');
  });

  it('refuses a malformed run id before touching a path', async () => {
    for (const runId of ['..', '../../etc/passwd', '', 'not-a-run-id']) {
      const error = await verifyRunEvidence(runStore, runId).catch((caught: unknown) => caught);
      expect((error as RunEvidenceError).kind).toBe('RUN_NOT_FOUND');
    }
  });

  it('refuses a P1-B manifest schema v1 Run rather than migrating it', async () => {
    await writeRun(RUN_ID, { schemaVersion: 1 });
    const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
    expect((error as RunEvidenceError).kind).toBe('RUN_MANIFEST_SCHEMA_UNSUPPORTED');
    expect((error as RunEvidenceError).detail).toContain('schema_version=1');
  });

  it('refuses an unknown future schema too', async () => {
    await writeRun(RUN_ID, { schemaVersion: 99 });
    const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
    expect((error as RunEvidenceError).kind).toBe('RUN_MANIFEST_SCHEMA_UNSUPPORTED');
  });

  it('refuses a manifest that is not JSON', async () => {
    await runStore.saveRun(RUN_ID, {
      sourceText: SOURCE_TEXT,
      audio: AUDIO,
      providerQueryJson: PROVIDER_QUERY,
      manifestJson: Buffer.from('not json', 'utf8'),
    });
    const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
    expect((error as RunEvidenceError).kind).toBe('RUN_MANIFEST_UNREADABLE');
  });

  for (const omit of ['source', 'audio', 'provider_query', 'segmentation', 'voice'] as const) {
    it(`refuses a manifest missing its ${omit} section`, async () => {
      await writeRun(RUN_ID, { omit });
      const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
      expect((error as RunEvidenceError).kind).toBe('RUN_MANIFEST_INCOMPLETE');
    });
  }

  it('refuses a Run whose audio no longer hashes to the manifest value', async () => {
    await writeRun(RUN_ID, { audioSha256: 'f'.repeat(64) });
    const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
    expect((error as RunEvidenceError).kind).toBe('RUN_HASH_MISMATCH');
    expect((error as RunEvidenceError).message).toContain('audio.wav');
  });

  it('refuses a Run whose file was replaced after it was written', async () => {
    await writeRun();
    // Tamper directly, the way an editor or a sync tool might.
    await writeFile(path.join(runStore.resolveRunDir(RUN_ID), 'source.txt'), '書き換えられた本文');
    const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
    expect((error as RunEvidenceError).kind).toBe('RUN_HASH_MISMATCH');
    expect((error as RunEvidenceError).message).toContain('source.txt');
  });

  it('refuses a Run with a missing bundle file', async () => {
    await writeRun();
    await rm(path.join(runStore.resolveRunDir(RUN_ID), 'audio.wav'));
    const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
    expect((error as RunEvidenceError).kind).toBe('RUN_FILE_MISSING');
  });
});

describe('run catalogue', () => {
  it('lists verifiable Runs newest first and skips the rest', async () => {
    await writeRun(RUN_ID);
    await writeRun(OTHER_RUN_ID, { testId: 'architecture-long-001' });
    // A v1 Run and a junk directory are both invisible to the picker.
    await writeRun('20260906T011345000Z-99887766', { schemaVersion: 1 });
    await writeFile(path.join(runsRoot, 'stray.txt'), 'x');

    const catalog = await listVerifiableRuns(runStore);
    expect(catalog.map((entry) => entry.runId)).toEqual([OTHER_RUN_ID, RUN_ID]);
    expect(catalog[0]).toMatchObject({
      testId: 'architecture-long-001',
      voiceLabel: 'まお / ノーマル',
      audioSha256: sha(AUDIO),
    });
  });

  it('returns an empty catalogue when the runs root is empty', async () => {
    expect(await listVerifiableRuns(runStore)).toEqual([]);
  });
});

describe('saveManualSttResult', () => {
  it('writes the two-file Result bundle citing verified Run evidence', async () => {
    await writeRun();

    const outcome = await saveManualSttResult(INPUT, {
      runStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    });

    expect((await readdir(outcome.resultDir)).sort()).toEqual(['result.json', 'transcript.txt']);

    const result = outcome.result;
    expect(result.schema_version).toBe(1);
    expect(result.result_id).toBe(RESULT_ID);
    expect(result.run_id).toBe(RUN_ID);
    expect(result.captured_at).toBe(NOW.toISOString());
    expect(result.tool).toEqual({
      id: 'windows-standard-voice-input',
      name: 'Windows 標準音声入力',
      version: null,
    });
    expect(result.capture).toEqual({ method: 'manual-paste', delivery_path: 'speaker-to-mic' });
    expect(result.run_evidence).toEqual({
      manifest_schema_version: 2,
      test_id: 'architecture-short-001',
      source_sha256: sha(SOURCE_TEXT),
      audio_sha256: sha(AUDIO),
    });
    expect(result.transcript).toMatchObject({
      file: 'transcript.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
    });
  });

  it('stores the transcript exactly as pasted, modulo line endings', async () => {
    await writeRun();
    const raw = '  先頭に空白\r\n二行目\rそして末尾に空白  ';
    const canonical = '  先頭に空白\n二行目\nそして末尾に空白  ';

    const outcome = await saveManualSttResult(
      { ...INPUT, rawTranscript: raw },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    );

    const stored = await readFile(path.join(outcome.resultDir, 'transcript.txt'), 'utf8');
    expect(stored).toBe(canonical);
    expect(outcome.result.transcript.sha256).toBe(sha(canonical));
    expect(outcome.result.transcript.bytes).toBe(Buffer.byteLength(canonical, 'utf8'));
  });

  it('records a transcript hash that matches the bytes on disk', async () => {
    await writeRun();
    const outcome = await saveManualSttResult(INPUT, {
      runStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    });

    const bytes = await readFile(path.join(outcome.resultDir, 'transcript.txt'));
    expect(sha(new Uint8Array(bytes))).toBe(outcome.result.transcript.sha256);
    expect(bytes.byteLength).toBe(outcome.result.transcript.bytes);
  });

  it('writes a result.json whose parsed content equals the returned Result', async () => {
    await writeRun();
    const outcome = await saveManualSttResult(INPUT, {
      runStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    });

    const onDisk = JSON.parse(await readFile(path.join(outcome.resultDir, 'result.json'), 'utf8'));
    expect(onDisk).toEqual(outcome.result);
  });

  it('keeps the Phase 1 Run byte-identical across a save', async () => {
    await writeRun();
    const before = await runFingerprint(RUN_ID);

    await saveManualSttResult(INPUT, {
      runStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    });

    expect(await runFingerprint(RUN_ID)).toEqual(before);
    expect(Object.keys(before).sort()).toEqual([
      'audio.wav',
      'manifest.json',
      'provider-query.json',
      'source.txt',
    ]);
  });

  it('generates its own result id when none is injected', async () => {
    await writeRun();
    const outcome = await saveManualSttResult(INPUT, { runStore, resultStore, now: () => NOW });
    expect(outcome.resultId).toMatch(/^20260906T020000000Z-[0-9a-f]{8}$/);
  });

  it('refuses an empty transcript', async () => {
    await writeRun();
    await expect(
      saveManualSttResult(
        { ...INPUT, rawTranscript: '' },
        { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
      ),
    ).rejects.toMatchObject({ kind: 'EMPTY_TRANSCRIPT' });
    expect(await readdir(resultsRoot)).toEqual([]);
  });

  it('accepts a whitespace-only transcript as a real observation', async () => {
    await writeRun();
    const outcome = await saveManualSttResult(
      { ...INPUT, rawTranscript: '   ' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    );
    expect(await readFile(path.join(outcome.resultDir, 'transcript.txt'), 'utf8')).toBe('   ');
  });

  const REJECTIONS: Array<[string, Partial<typeof INPUT>, string]> = [
    ['an unknown tool id', { toolId: 'whisper' }, 'UNKNOWN_TOOL_ID'],
    ['an unknown delivery path', { deliveryPath: 'bluetooth' }, 'UNKNOWN_DELIVERY_PATH'],
  ];

  for (const [label, overrides, kind] of REJECTIONS) {
    it(`writes no Result for ${label}`, async () => {
      await writeRun();
      const error = await saveManualSttResult(
        { ...INPUT, ...overrides },
        { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ToolResolutionError);
      expect((error as ToolResolutionError).kind).toBe(kind);
      expect(await readdir(resultsRoot)).toEqual([]);
    });
  }

  it('writes no Result for a Run that cannot be verified', async () => {
    await writeRun(RUN_ID, { audioSha256: 'f'.repeat(64) });

    const error = await saveManualSttResult(INPUT, {
      runStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    }).catch((caught: unknown) => caught);

    expect((error as RunEvidenceError).kind).toBe('RUN_HASH_MISMATCH');
    expect(await readdir(resultsRoot)).toEqual([]);
  });

  it('writes no Result for an unknown Run', async () => {
    const error = await saveManualSttResult(INPUT, {
      runStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    }).catch((caught: unknown) => caught);

    expect((error as RunEvidenceError).kind).toBe('RUN_NOT_FOUND');
    expect(await readdir(resultsRoot)).toEqual([]);
  });

  it('refuses a second Result with the same id and keeps the first intact', async () => {
    await writeRun();
    const first = await saveManualSttResult(
      { ...INPUT, rawTranscript: '最初の観測' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    );

    await expect(
      saveManualSttResult(
        { ...INPUT, rawTranscript: '二回目' },
        { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
      ),
    ).rejects.toMatchObject({ kind: 'RESULT_ALREADY_EXISTS' });

    expect(await readFile(path.join(first.resultDir, 'transcript.txt'), 'utf8')).toBe('最初の観測');
  });
});

describe('listResultsForRun', () => {
  async function saveTwoToolsForOneRun() {
    await writeRun();
    await saveManualSttResult(
      { ...INPUT, toolId: 'windows-standard-voice-input', rawTranscript: 'Windows の書き起こし' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    );
    await saveManualSttResult(
      { ...INPUT, toolId: 'aqua-voice', rawTranscript: 'Aqua の書き起こし' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID_2 },
    );
  }

  it('returns both tools for the same Run, oldest first', async () => {
    await saveTwoToolsForOneRun();

    const entries = await listResultsForRun(resultStore, RUN_ID);
    expect(entries.map((entry) => entry.result.tool.id)).toEqual([
      'windows-standard-voice-input',
      'aqua-voice',
    ]);
    expect(entries.map((entry) => entry.transcript)).toEqual([
      'Windows の書き起こし',
      'Aqua の書き起こし',
    ]);
  });

  it('has both Results citing the same run_id and audio_sha256', async () => {
    await saveTwoToolsForOneRun();

    const entries = await listResultsForRun(resultStore, RUN_ID);
    expect(new Set(entries.map((entry) => entry.result.run_id))).toEqual(new Set([RUN_ID]));
    expect(new Set(entries.map((entry) => entry.result.run_evidence.audio_sha256))).toEqual(
      new Set([sha(AUDIO)]),
    );
  });

  it('filters on the stored run_id, not on anything else', async () => {
    await saveTwoToolsForOneRun();
    await writeRun(OTHER_RUN_ID);
    await saveManualSttResult(
      { ...INPUT, runId: OTHER_RUN_ID, rawTranscript: '別の Run の観測' },
      { runStore, resultStore, now: () => NOW, resultId: '20260906T020002000Z-0badf00d' },
    );

    expect(await listResultsForRun(resultStore, RUN_ID)).toHaveLength(2);
    expect(await listResultsForRun(resultStore, OTHER_RUN_ID)).toHaveLength(1);
    expect(await listResultsForRun(resultStore, '20260906T999999999Z-00000000')).toEqual([]);
  });

  it('leaves the Phase 1 Run untouched after two Results', async () => {
    await writeRun();
    const before = await runFingerprint(RUN_ID);
    await saveTwoToolsForOneRun().catch(() => {});
    expect(await runFingerprint(RUN_ID)).toEqual(before);
  });
});
