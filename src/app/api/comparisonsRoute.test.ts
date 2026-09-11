import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { saveManualSttResult } from '@/results/saveResult';
import type { ComparisonRun } from '@/comparisons/runComparison';
import { POST as postEvaluation, GET as getEvaluations } from './evaluations/route';
import { GET as getResults } from './results/route';
import { GET as getComparison } from './comparisons/run/[runId]/route';

const RUN_ID = '20260910T030000000Z-aaaaaaaa';
const MISSING_RUN_ID = '20260910T030000000Z-bbbbbbbb';
const WINDOWS_RESULT_ID = '20260910T030100000Z-cccccccc';
const AQUA_RESULT_ID = '20260910T030200000Z-dddddddd';
const NOW = new Date('2026-09-10T03:00:00.000Z');

const SOURCE_TEXT = '天井高は二千七百ミリを確保してください。';
const TRANSCRIPT = '天井高は2700ミリを確保してください。';
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

function manifest(runId: string): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: runId,
    test_id: 'numbers-units-001',
    generated_at: NOW.toISOString(),
    source: { file: 'source.txt', encoding: 'utf-8', line_endings: 'lf', sha256: sha(SOURCE_TEXT) },
    provider: {
      id: 'aivisspeech',
      engine_name: 'AivisSpeech',
      engine_version: '1.1.0-dev',
      engine_url: 'http://127.0.0.1:10101',
    },
    model: { uuid: 'm', name: 'まお', version: '1.2.0' },
    voice: { speaker_uuid: 's', speaker_name: 'まお', style_id: 1, style_name: 'ノーマル' },
    settings: { speed_scale: 1, volume_scale: 1, sample_rate: 44100, stereo: false },
    segmentation: { strategy: 'none', target_max_chars: 450, segment_count: 1 },
    provider_query: { file: 'provider-query.json', sha256: sha(PROVIDER_QUERY) },
    audio: {
      file: 'audio.wav',
      content_type: 'audio/wav',
      sha256: sha(AUDIO),
      bytes: AUDIO.byteLength,
    },
    reproducibility: { canonical_artifact: true, bit_exact_regeneration_expected: false },
  };
}

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;
let evaluationsRoot: string;

async function writeRun(): Promise<void> {
  await new LocalRunStore(runsRoot).saveRun(RUN_ID, {
    sourceText: SOURCE_TEXT,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifest(RUN_ID), null, 2)}\n`, 'utf8'),
  });
}

async function saveResult(resultId: string, toolId: 'windows-standard-voice-input' | 'aqua-voice') {
  await saveManualSttResult(
    { runId: RUN_ID, toolId, deliveryPath: 'speaker-to-mic', rawTranscript: TRANSCRIPT },
    {
      runStore: new LocalRunStore(runsRoot),
      resultStore: new LocalResultStore(resultsRoot),
      now: () => NOW,
      resultId,
    },
  );
}

async function createEvaluationVia(resultId: string, evaluatorId: string): Promise<string> {
  const response = await postEvaluation(
    new Request('http://localhost/api/evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId, evaluatorId }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { evaluationId: string }).evaluationId;
}

function comparisonRequest(runId: string) {
  return getComparison(new Request(`http://localhost/api/comparisons/run/${runId}`), {
    params: Promise.resolve({ runId }),
  });
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[path.relative(root, full)] = sha(await readFile(full));
    }
  };
  await walk(root);
  return files;
}

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-croute-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-croute-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-croute-sessions-'));
  evaluationsRoot = await mkdtemp(path.join(tmpdir(), 'vib-croute-evaluations-'));
  process.env.VIB_RUNS_DIR = runsRoot;
  process.env.VIB_RESULTS_DIR = resultsRoot;
  process.env.VIB_SESSIONS_DIR = sessionsRoot;
  process.env.VIB_EVALUATIONS_DIR = evaluationsRoot;
});

afterEach(async () => {
  delete process.env.VIB_RUNS_DIR;
  delete process.env.VIB_RESULTS_DIR;
  delete process.env.VIB_SESSIONS_DIR;
  delete process.env.VIB_EVALUATIONS_DIR;
  for (const root of [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('GET /api/comparisons/run/[runId]', () => {
  it('returns the derived comparison, covering exactly what the Results and Evaluations APIs list', async () => {
    await writeRun();
    await saveResult(WINDOWS_RESULT_ID, 'windows-standard-voice-input');
    await saveResult(AQUA_RESULT_ID, 'aqua-voice');
    const raw = await createEvaluationVia(WINDOWS_RESULT_ID, 'raw-char-v1');
    const critical = await createEvaluationVia(AQUA_RESULT_ID, 'critical-info-v1');

    const response = await comparisonRequest(RUN_ID);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true } & ComparisonRun;

    expect(body.ok).toBe(true);
    expect(body.run_id).toBe(RUN_ID);
    expect(body.tools.map((group) => group.tool)).toEqual([
      { kind: 'built-in', id: 'windows-standard-voice-input' },
      { kind: 'built-in', id: 'aqua-voice' },
    ]);

    // The same Run through the existing APIs: nothing more, nothing less.
    const query = `?runId=${RUN_ID}`;
    const results = (await (await getResults(new Request(`http://localhost/api/results${query}`))).json()) as {
      results: Array<{ resultId: string }>;
    };
    const evaluations = (await (
      await getEvaluations(new Request(`http://localhost/api/evaluations${query}`))
    ).json()) as { evaluations: Array<{ evaluationId: string }> };
    const placedResults = body.tools.flatMap((group) => group.results.map((r) => r.result_id));
    expect(placedResults).toEqual(results.results.map((r) => r.resultId));
    const placedEvaluations = body.tools.flatMap((group) =>
      group.results.flatMap((result) =>
        result.kind === 'verified'
          ? result.evaluations.flatMap((g) => g.entries.map((e) => e.evaluation_id))
          : [],
      ),
    );
    expect(placedEvaluations.sort()).toEqual(evaluations.evaluations.map((e) => e.evaluationId).sort());
    expect(placedEvaluations.sort()).toEqual([raw, critical].sort());
  });

  it('writes nothing, however many times it is read', async () => {
    await writeRun();
    await saveResult(WINDOWS_RESULT_ID, 'windows-standard-voice-input');
    await createEvaluationVia(WINDOWS_RESULT_ID, 'raw-char-v1');
    const roots = [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot];
    const before = await Promise.all(roots.map(snapshot));

    for (let i = 0; i < 3; i += 1) expect((await comparisonRequest(RUN_ID)).status).toBe(200);

    expect(await Promise.all(roots.map(snapshot))).toEqual(before);
  });

  it('404s a Run that does not exist, and an id that is not a Run id', async () => {
    await writeRun();
    for (const runId of [MISSING_RUN_ID, 'not-a-run-id']) {
      const response = await comparisonRequest(runId);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { ok: boolean; error: { kind: string } };
      expect(body.ok).toBe(false);
      expect(body.error.kind).toBe('RUN_NOT_FOUND');
    }
  });

  it('fails as a whole with 409 when the Run no longer verifies — no partial comparison', async () => {
    await writeRun();
    await saveResult(WINDOWS_RESULT_ID, 'windows-standard-voice-input');
    await createEvaluationVia(WINDOWS_RESULT_ID, 'raw-char-v1');
    await writeFile(path.join(runsRoot, RUN_ID, 'audio.wav'), Buffer.from('not the audio'));

    const response = await comparisonRequest(RUN_ID);

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown> & {
      ok: boolean;
      error: { kind: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe('RUN_HASH_MISMATCH');
    for (const partial of ['tools', 'legacy_unsealed_results', 'unattributed_results']) {
      expect(body).not.toHaveProperty(partial);
    }
  });

  it('leaves the existing Results and Evaluations APIs as they were', async () => {
    await writeRun();
    await saveResult(WINDOWS_RESULT_ID, 'windows-standard-voice-input');
    await createEvaluationVia(WINDOWS_RESULT_ID, 'raw-char-v1');
    await comparisonRequest(RUN_ID);

    const results = (await (
      await getResults(new Request(`http://localhost/api/results?runId=${RUN_ID}`))
    ).json()) as Record<string, unknown>;
    const evaluations = (await (
      await getEvaluations(new Request(`http://localhost/api/evaluations?runId=${RUN_ID}`))
    ).json()) as Record<string, unknown>;

    expect(Object.keys(results).sort()).toEqual(['ok', 'results', 'runId']);
    expect(Object.keys(evaluations).sort()).toEqual(['evaluations', 'ok', 'runId']);
  });
});
