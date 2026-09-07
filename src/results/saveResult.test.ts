import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { RunEvidenceError, listVerifiableRuns, verifyRunEvidence } from './runEvidence';
import { listResultsForRun, saveManualSttResult } from './saveResult';
import { ToolResolutionError } from './tools';
import { StorageBoundaryError } from '@/storage/rootIsolation';

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
  async function listAll(runId: string) {
    return listResultsForRun({ runStore, resultStore }, runId);
  }

  async function listVerified(runId: string) {
    const entries = await listAll(runId);
    return entries.flatMap((entry) => (entry.status === 'verified' ? [entry] : []));
  }

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

    const entries = await listVerified(RUN_ID);
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

    const entries = await listVerified(RUN_ID);
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

    expect(await listAll(RUN_ID)).toHaveLength(2);
    expect(await listAll(OTHER_RUN_ID)).toHaveLength(1);
  });

  it('fails the listing when the Run itself cannot be verified', async () => {
    await saveTwoToolsForOneRun();
    await writeFile(path.join(runStore.resolveRunDir(RUN_ID), 'audio.wav'), '差し替え');

    const error = await listAll(RUN_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunEvidenceError);
    expect((error as RunEvidenceError).kind).toBe('RUN_HASH_MISMATCH');
  });

  it('leaves the Phase 1 Run untouched after two Results', async () => {
    await writeRun();
    const before = await runFingerprint(RUN_ID);
    await saveTwoToolsForOneRun().catch(() => {});
    expect(await runFingerprint(RUN_ID)).toEqual(before);
  });
});

describe('RF-1: the manifest must name the Run it sits in', () => {
  it('refuses a Run Bundle copied wholesale into another Run id', async () => {
    // Every file hashes correctly — they are Run A's files, and Run A's
    // manifest. Only the directory name says Run B.
    await writeRun(RUN_ID);
    const sourceDir = runStore.resolveRunDir(RUN_ID);
    const targetDir = runStore.resolveRunDir(OTHER_RUN_ID);
    await cp(sourceDir, targetDir, { recursive: true });

    // Sanity: the copy is byte-identical.
    expect(await runFingerprint(OTHER_RUN_ID)).toEqual(await runFingerprint(RUN_ID));

    const error = await verifyRunEvidence(runStore, OTHER_RUN_ID).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RunEvidenceError);
    expect((error as RunEvidenceError).kind).toBe('RUN_ID_MISMATCH');
    expect((error as RunEvidenceError).detail).toContain(RUN_ID);
  });

  it('writes no Result for a Run whose manifest names a different Run', async () => {
    await writeRun(RUN_ID);
    await cp(runStore.resolveRunDir(RUN_ID), runStore.resolveRunDir(OTHER_RUN_ID), {
      recursive: true,
    });

    const error = await saveManualSttResult(
      { ...INPUT, runId: OTHER_RUN_ID },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    ).catch((caught: unknown) => caught);

    expect((error as RunEvidenceError).kind).toBe('RUN_ID_MISMATCH');
    expect(await readdir(resultsRoot)).toEqual([]);
  });

  it('keeps such a Run out of the catalogue', async () => {
    await writeRun(RUN_ID);
    await cp(runStore.resolveRunDir(RUN_ID), runStore.resolveRunDir(OTHER_RUN_ID), {
      recursive: true,
    });

    const catalog = await listVerifiableRuns(runStore);
    expect(catalog.map((entry) => entry.runId)).toEqual([RUN_ID]);
  });

  for (const [section, file] of [
    ['source', 'source.txt'],
    ['audio', 'audio.wav'],
    ['provider_query', 'provider-query.json'],
  ] as const) {
    it(`refuses a manifest whose ${section}.file is not ${file}`, async () => {
      await writeRun();
      const manifestPath = path.join(runStore.resolveRunDir(RUN_ID), 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
      manifest[section]!.file = 'somewhere-else.bin';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const error = await verifyRunEvidence(runStore, RUN_ID).catch((caught: unknown) => caught);
      expect((error as RunEvidenceError).kind).toBe('RUN_MANIFEST_FILE_MISMATCH');
    });
  }
});

describe('RF-2: runs and results roots must be separate trees', () => {
  async function expectIsolationRefusal(resultsDir: string) {
    const store = new LocalResultStore(resultsDir);
    const error = await saveManualSttResult(INPUT, {
      runStore,
      resultStore: store,
      now: () => NOW,
      resultId: RESULT_ID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StorageBoundaryError);
    expect((error as StorageBoundaryError).kind).toBe('ROOT_ISOLATION_VIOLATED');
    return error as StorageBoundaryError;
  }

  it('refuses equal roots', async () => {
    await writeRun();
    const before = await runFingerprint(RUN_ID);
    await expectIsolationRefusal(runsRoot);
    // Nothing was written into the Run tree.
    expect(await runFingerprint(RUN_ID)).toEqual(before);
    expect((await readdir(runsRoot)).sort()).toEqual([RUN_ID]);
  });

  it('refuses a results root nested inside the runs root', async () => {
    await writeRun();
    const before = await runFingerprint(RUN_ID);
    await expectIsolationRefusal(path.join(runsRoot, 'results'));
    expect(await runFingerprint(RUN_ID)).toEqual(before);
    expect((await readdir(runsRoot)).sort()).toEqual([RUN_ID]);
  });

  it('refuses a results root inside an existing Run directory', async () => {
    await writeRun();
    const before = await runFingerprint(RUN_ID);
    await expectIsolationRefusal(runStore.resolveRunDir(RUN_ID));
    expect(await runFingerprint(RUN_ID)).toEqual(before);
    expect((await readdir(runStore.resolveRunDir(RUN_ID))).sort()).toEqual([
      'audio.wav',
      'manifest.json',
      'provider-query.json',
      'source.txt',
    ]);
  });

  it('refuses a runs root nested inside the results root', async () => {
    const nestedRunsRoot = path.join(resultsRoot, 'runs');
    const nestedRunStore = new LocalRunStore(nestedRunsRoot);
    await nestedRunStore.saveRun(RUN_ID, {
      sourceText: SOURCE_TEXT,
      audio: AUDIO,
      providerQueryJson: PROVIDER_QUERY,
      manifestJson: Buffer.from(`${JSON.stringify(manifestFor(RUN_ID), null, 2)}\n`, 'utf8'),
    });

    const error = await saveManualSttResult(INPUT, {
      runStore: nestedRunStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    }).catch((caught: unknown) => caught);

    expect((error as StorageBoundaryError).kind).toBe('ROOT_ISOLATION_VIOLATED');
  });

  it('accepts normal sibling roots', async () => {
    await writeRun();
    const outcome = await saveManualSttResult(INPUT, {
      runStore,
      resultStore,
      now: () => NOW,
      resultId: RESULT_ID,
    });
    expect(outcome.resultId).toBe(RESULT_ID);
  });

  it('refuses the same violation on the read path', async () => {
    await writeRun();
    const error = await listResultsForRun(
      { runStore, resultStore: new LocalResultStore(runsRoot) },
      RUN_ID,
    ).catch((caught: unknown) => caught);
    expect((error as StorageBoundaryError).kind).toBe('ROOT_ISOLATION_VIOLATED');
  });
});

describe('RF-3: stored Results are verified on read', () => {
  async function seed() {
    await writeRun();
    await saveManualSttResult(
      { ...INPUT, rawTranscript: 'Windows の書き起こし' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    );
  }

  async function listOne() {
    const entries = await listResultsForRun({ runStore, resultStore }, RUN_ID);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  async function patchResultJson(mutate: (result: Record<string, unknown>) => void) {
    const file = resultStore.resolveResultFile(RESULT_ID, 'result.json');
    const result = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    mutate(result);
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  }

  it('returns a verified entry for an untouched Result', async () => {
    await seed();
    const entry = await listOne();
    expect(entry.status).toBe('verified');
  });

  it('rejects a tampered transcript.txt', async () => {
    await seed();
    await writeFile(
      resultStore.resolveResultFile(RESULT_ID, 'transcript.txt'),
      '書き換えられた書き起こし',
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      // Length changed too, so either integrity check may fire first.
      expect([
        'RESULT_TRANSCRIPT_HASH_MISMATCH',
        'RESULT_TRANSCRIPT_BYTES_MISMATCH',
      ]).toContain(entry.reason);
    }
  });

  it('rejects a transcript whose byte length no longer matches', async () => {
    await seed();
    // Same recorded hash, different recorded length.
    await patchResultJson((result) => {
      (result.transcript as Record<string, unknown>).bytes = 9999;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('RESULT_TRANSCRIPT_BYTES_MISMATCH');
    }
  });

  it('rejects a tampered result_id', async () => {
    await seed();
    await patchResultJson((result) => {
      result.result_id = RESULT_ID_2;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_ID_MISMATCH');
  });

  it('skips a Result that claims a different run_id', async () => {
    await seed();
    await patchResultJson((result) => {
      result.run_id = OTHER_RUN_ID;
    });

    // It is no longer this Run's business, so it simply does not appear here.
    expect(await listResultsForRun({ runStore, resultStore }, RUN_ID)).toEqual([]);
  });

  it('rejects tampered audio evidence', async () => {
    await seed();
    await patchResultJson((result) => {
      (result.run_evidence as Record<string, unknown>).audio_sha256 = 'f'.repeat(64);
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_RUN_EVIDENCE_MISMATCH');
  });

  it('rejects tampered source evidence', async () => {
    await seed();
    await patchResultJson((result) => {
      (result.run_evidence as Record<string, unknown>).source_sha256 = 'a'.repeat(64);
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_RUN_EVIDENCE_MISMATCH');
  });

  it('rejects a tampered test_id in the run evidence', async () => {
    await seed();
    await patchResultJson((result) => {
      (result.run_evidence as Record<string, unknown>).test_id = 'manual';
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_RUN_EVIDENCE_MISMATCH');
  });

  it('rejects an unsupported result schema', async () => {
    await seed();
    await patchResultJson((result) => {
      result.schema_version = 2;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_SCHEMA_UNSUPPORTED');
  });

  it('rejects a broken transcript contract', async () => {
    await seed();
    await patchResultJson((result) => {
      (result.transcript as Record<string, unknown>).line_endings = 'crlf';
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('RESULT_TRANSCRIPT_CONTRACT_MISMATCH');
    }
  });

  it('rejects a transcript that contains CR despite claiming lf', async () => {
    await seed();
    await writeFile(resultStore.resolveResultFile(RESULT_ID, 'transcript.txt'), 'a\r\nb');

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
  });

  it('reports a missing transcript rather than hiding the Result', async () => {
    await seed();
    await rm(resultStore.resolveResultFile(RESULT_ID, 'transcript.txt'));

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_TRANSCRIPT_MISSING');
  });

  it('still lists two valid Results side by side', async () => {
    await writeRun();
    await saveManualSttResult(
      { ...INPUT, rawTranscript: 'Windows の書き起こし' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    );
    await saveManualSttResult(
      { ...INPUT, toolId: 'aqua-voice', rawTranscript: 'Aqua の書き起こし' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID_2 },
    );

    const entries = await listResultsForRun({ runStore, resultStore }, RUN_ID);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.status === 'verified')).toBe(true);
  });
});

describe('RF-2: tool and capture contract on readback', () => {
  async function seed(toolId = 'windows-standard-voice-input') {
    await writeRun();
    return saveManualSttResult(
      { ...INPUT, toolId, toolVersion: '24H2', rawTranscript: '観測' },
      { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
    );
  }

  async function patchResultJson(mutate: (result: Record<string, unknown>) => void) {
    const file = resultStore.resolveResultFile(RESULT_ID, 'result.json');
    const result = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    mutate(result);
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  }

  async function listOne() {
    const entries = await listResultsForRun({ runStore, resultStore }, RUN_ID);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  it('accepts an untouched Windows Result', async () => {
    await seed('windows-standard-voice-input');
    const entry = await listOne();
    expect(entry.status).toBe('verified');
  });

  it('accepts an untouched Aqua Voice Result', async () => {
    await seed('aqua-voice');
    const entry = await listOne();
    expect(entry.status).toBe('verified');
  });

  const TAMPERS: Array<[string, (result: Record<string, unknown>) => void, string]> = [
    [
      'an unknown tool.id',
      (result) => {
        (result.tool as Record<string, unknown>).id = 'whisper';
      },
      'RESULT_TOOL_CONTRACT_MISMATCH',
    ],
    [
      'the Windows id under the Aqua name',
      (result) => {
        (result.tool as Record<string, unknown>).name = 'Aqua Voice';
      },
      'RESULT_TOOL_CONTRACT_MISMATCH',
    ],
    [
      'the Aqua id under the Windows name',
      (result) => {
        const tool = result.tool as Record<string, unknown>;
        tool.id = 'aqua-voice';
      },
      'RESULT_TOOL_CONTRACT_MISMATCH',
    ],
    [
      '`other` with a blank name',
      (result) => {
        const tool = result.tool as Record<string, unknown>;
        tool.id = 'other';
        tool.name = '   ';
      },
      'RESULT_TOOL_CONTRACT_MISMATCH',
    ],
    [
      'a non-string tool.version',
      (result) => {
        (result.tool as Record<string, unknown>).version = 42;
      },
      'RESULT_TOOL_CONTRACT_MISMATCH',
    ],
    [
      'an untrimmed tool.version',
      (result) => {
        (result.tool as Record<string, unknown>).version = '  24H2  ';
      },
      'RESULT_TOOL_CONTRACT_MISMATCH',
    ],
    [
      'a tampered capture.method',
      (result) => {
        (result.capture as Record<string, unknown>).method = 'automated';
      },
      'RESULT_CAPTURE_CONTRACT_MISMATCH',
    ],
    [
      'an unknown delivery_path',
      (result) => {
        (result.capture as Record<string, unknown>).delivery_path = 'bluetooth';
      },
      'RESULT_CAPTURE_CONTRACT_MISMATCH',
    ],
    [
      'an invalid captured_at',
      (result) => {
        result.captured_at = 'not a date';
      },
      'RESULT_CAPTURED_AT_INVALID',
    ],
  ];

  for (const [label, mutate, kind] of TAMPERS) {
    it(`rejects ${label}`, async () => {
      await seed();
      await patchResultJson(mutate);

      const entry = await listOne();
      expect(entry.status).toBe('rejected');
      if (entry.status === 'rejected') expect(entry.reason).toBe(kind);
    });
  }

  it('keeps a trusted tool id when only the transcript was tampered with', async () => {
    await seed('aqua-voice');
    await writeFile(resultStore.resolveResultFile(RESULT_ID, 'transcript.txt'), '書き換え');

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('RESULT_TRANSCRIPT_HASH_MISMATCH');
      // The tool section is intact, so the failure has a known owner.
      expect(entry.trustedToolId).toBe('aqua-voice');
    }
  });

  it('reports no trusted tool id when the tool section itself is broken', async () => {
    await seed();
    await patchResultJson((result) => {
      (result.tool as Record<string, unknown>).id = 'whisper';
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.trustedToolId).toBeUndefined();
  });
});
