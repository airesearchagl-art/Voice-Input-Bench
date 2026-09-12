import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { saveManualSttResult } from '@/results/saveResult';
import type { ReportPackage } from '@/reports/buildReport';
import type { RerenderOutcome } from '@/reports/rerenderReport';
import { POST as postEvaluation } from './evaluations/route';
import { GET as getReport } from './reports/run/[runId]/route';
import { POST as postRerender } from './reports/rerender/route';

const RUN_ID = '20260911T040000000Z-aaaaaaaa';
const MISSING_RUN_ID = '20260911T040000000Z-bbbbbbbb';
const RESULT_ID = '20260911T040100000Z-cccccccc';
const NOW = new Date('2026-09-11T04:00:00.000Z');

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
    audio: { file: 'audio.wav', content_type: 'audio/wav', sha256: sha(AUDIO), bytes: AUDIO.byteLength },
    reproducibility: { canonical_artifact: true, bit_exact_regeneration_expected: false },
  };
}

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;
let evaluationsRoot: string;

async function seed(): Promise<void> {
  await new LocalRunStore(runsRoot).saveRun(RUN_ID, {
    sourceText: SOURCE_TEXT,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifest(RUN_ID), null, 2)}\n`, 'utf8'),
  });
  await saveManualSttResult(
    { runId: RUN_ID, toolId: 'aqua-voice', deliveryPath: 'speaker-to-mic', rawTranscript: TRANSCRIPT },
    {
      runStore: new LocalRunStore(runsRoot),
      resultStore: new LocalResultStore(resultsRoot),
      now: () => NOW,
      resultId: RESULT_ID,
    },
  );
  const response = await postEvaluation(
    new Request('http://localhost/api/evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId: RESULT_ID, evaluatorId: 'critical-info-v1' }),
    }),
  );
  expect(response.status).toBe(201);
}

function reportRequest(runId: string) {
  return getReport(new Request(`http://localhost/api/reports/run/${runId}`), {
    params: Promise.resolve({ runId }),
  });
}

function rerenderRequest(body: string) {
  return postRerender(
    new Request('http://localhost/api/reports/rerender', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  );
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
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rroute-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rroute-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rroute-sessions-'));
  evaluationsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rroute-evaluations-'));
  process.env.VIB_RUNS_DIR = runsRoot;
  process.env.VIB_RESULTS_DIR = resultsRoot;
  process.env.VIB_SESSIONS_DIR = sessionsRoot;
  process.env.VIB_EVALUATIONS_DIR = evaluationsRoot;
  // Any attempt to reach a model would fail loudly rather than quietly succeed.
  process.env.VIB_SEMANTIC_ENDPOINT = 'http://127.0.0.1:1';
});

afterEach(async () => {
  for (const key of ['VIB_RUNS_DIR', 'VIB_RESULTS_DIR', 'VIB_SESSIONS_DIR', 'VIB_EVALUATIONS_DIR', 'VIB_SEMANTIC_ENDPOINT']) {
    delete process.env[key];
  }
  for (const root of [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('GET /api/reports/run/[runId]', () => {
  it('returns both files of one package, uncached, and writes nothing', async () => {
    await seed();
    const roots = [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot];
    const before = await Promise.all(roots.map(snapshot));

    const response = await reportRequest(RUN_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as { ok: true } & ReportPackage;
    expect(body.ok).toBe(true);
    expect(body.report_source.run_id).toBe(RUN_ID);
    expect(JSON.parse(body.report_source_json)).toEqual(body.report_source);
    expect(body.markdown.startsWith(body.markdown_body)).toBe(true);
    expect(body.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.filenames.source).toBe(`vib-report-${RUN_ID}-${body.content_sha256.slice(0, 12)}.source.json`);
    expect(await Promise.all(roots.map(snapshot))).toEqual(before);
    // No report root appears anywhere.
    expect(await readdir(path.dirname(runsRoot))).not.toContain('reports');
  });

  it('fails as a whole: 404 for no such Run, 409 for a Run that no longer verifies', async () => {
    await seed();
    expect((await reportRequest(MISSING_RUN_ID)).status).toBe(404);
    expect((await reportRequest('..%2F..%2Fetc')).status).toBe(404);

    await writeFile(path.join(runsRoot, RUN_ID, 'audio.wav'), Buffer.from('not the audio'));
    const response = await reportRequest(RUN_ID);
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown> & { error: { kind: string } };
    expect(body.error.kind).toBe('RUN_HASH_MISMATCH');
    expect(body).not.toHaveProperty('report_source');
  });
});

describe('POST /api/reports/rerender', () => {
  async function exportedSourceJson(): Promise<{ json: string; content: string }> {
    const body = (await (await reportRequest(RUN_ID)).json()) as ReportPackage;
    return { json: body.report_source_json, content: body.content_sha256 };
  }

  it('reproduces an unchanged report: same content_sha256, no findings', async () => {
    await seed();
    const { json, content } = await exportedSourceJson();

    const response = await rerenderRequest(json);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true } & RerenderOutcome;
    expect(body.status).toBe('reproduced');
    expect(body.content_sha256).toBe(content);
    expect(body.evidence_changed).toEqual([]);
    expect(body.verification_changed).toEqual([]);
  });

  it('answers a changed Run basis with 409 and structured hashes, never file contents', async () => {
    await seed();
    const { json } = await exportedSourceJson();
    await writeFile(path.join(runsRoot, RUN_ID, 'source.txt'), '別の文章。');

    const response = await rerenderRequest(json);

    expect(response.status).toBe(409);
    const text = await response.text();
    const body = JSON.parse(text) as {
      ok: false;
      error: { kind: string; evidence_changed: Array<Record<string, unknown>> };
    };
    expect(body.error.kind).toBe('REPORT_RUN_BASIS_CHANGED');
    expect(body.error.evidence_changed).toEqual([
      {
        artifact_kind: 'source',
        artifact_id: RUN_ID,
        expected_sha256: sha(SOURCE_TEXT),
        actual_sha256: sha('別の文章。'),
        change: 'modified',
      },
    ]);
    expect(text).not.toContain('別の文章');
    expect(text).not.toContain(SOURCE_TEXT);
  });

  it('refuses a body that is not JSON, not a ReportSource, or points outside the stores', async () => {
    await seed();
    const { json } = await exportedSourceJson();

    const notJson = await rerenderRequest('{nope');
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: { kind: string } }).error.kind).toBe('REPORT_SOURCE_INVALID');

    const source = JSON.parse(json) as Record<string, unknown>;
    for (const runId of ['../../etc', 'C:\\Windows', '\\\\server\\share']) {
      const response = await rerenderRequest(JSON.stringify({ ...source, run_id: runId }));
      expect(response.status).toBe(400);
    }
    const withPath = await rerenderRequest(JSON.stringify({ ...source, path: '/etc/passwd' }));
    expect(withPath.status).toBe(400);
  });

  it('refuses an oversized body before parsing it', async () => {
    const response = await rerenderRequest(`"${'x'.repeat(8 * 1024 * 1024 + 1)}"`);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { kind: string } }).error.kind).toBe('REPORT_SOURCE_TOO_LARGE');
  });
});
