import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalSessionStore } from '@/storage/LocalSessionStore';
import { LocalEvaluationStore } from '@/storage/LocalEvaluationStore';
import { listResultsForRun, saveManualSttResult } from '@/results/saveResult';
import { verifyRunEvidence } from '@/results/runEvidence';
import { BUILT_IN_TOOL_NAMES } from '@/results/tools';
import {
  createEvaluation,
  listEvaluationsForRun,
  verifyEvaluationListEntry,
  type EvaluationDeps,
  type EvaluatorId,
  type SemanticRunner,
} from '@/evaluation/createEvaluation';
import {
  SEMANTIC_MODEL_DIGEST,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_QUANTIZATION,
  SEMANTIC_PROVIDER_PROTOCOL,
  SEMANTIC_RUNTIME_VERSION,
  type SemanticRuntimeFacts,
} from '@/evaluation/semanticProvider';
import { SEMANTIC_RUBRIC_V1_SHA256 } from '@/evaluation/semanticPrompt';
import { assembleRunComparison, type RunComparisonDeps } from '@/comparisons/runComparison';
import { hashCitedArtifacts } from './artifactBytes';
import { buildReportPackage, type ReportPackage } from './buildReport';
import { ReportError } from './reportErrors';
import {
  completenessOf,
  evaluationPartitionOf,
  reportSourceOf,
  validateReportSource,
  type ReportSource,
  type ReportVerifiedResultSource,
} from './reportSource';
import {
  CRITICAL_VETO_ROUTE_NOTE,
  PRESENTATION_FOOTER_MARKER,
  SELF_CORRECTION_LIMITATION_NOTE,
  renderReportBody,
  reportContentSha256,
  splitReportMarkdown,
} from './renderReport';
import { rerenderReport } from './rerenderReport';

/**
 * Deterministic Report package and re-render, against real artifacts.
 *
 * Every Run, Result and Evaluation is written by the production writers and
 * read back by the production verifiers. Changed evidence is made the way it
 * happens in practice — by editing bytes on disk after the report was taken.
 */

const RUN_ID = '20260911T010000000Z-aaaaaaaa';
const NOW = new Date('2026-09-11T01:00:00.000Z');
const LATER = new Date('2026-09-12T09:30:00.000Z');

const SOURCE_TEXT = '天井高は二千七百ミリを確保してください。';
const TRANSCRIPT = '天井高は2700ミリを確保してください。';
const WRONG_VALUE_TRANSCRIPT = '天井高は2600ミリを確保してください。';
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

const R1 = '20260911T010100000Z-00000001';
const R2 = '20260911T010200000Z-00000002';
const R3 = '20260911T010300000Z-00000003';
const R4 = '20260911T010400000Z-00000004';
const R5 = '20260911T010500000Z-00000005';
const R6 = '20260911T010600000Z-00000006';
const R7 = '20260911T010700000Z-00000007';

const E1 = '20260911T020100000Z-e0000001';
const E2 = '20260911T020200000Z-e0000002';
const E3 = '20260911T020300000Z-e0000003';
const E4 = '20260911T020400000Z-e0000004';
const E5 = '20260911T020500000Z-e0000005';
const E6 = '20260911T020600000Z-e0000006';
const E7 = '20260911T020700000Z-e0000007';
const E9 = '20260911T020900000Z-e0000009';

/** A verdict-shaped word the report must never print. */
const GRADE_WORDS = /\b(PASS|PASSED|SAFE|PRESERVED|OK)\b/;
const SYNTHESIS_WORDS = /\b(score|ranking|winner|best tool|overall)\b/i;

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

// ── Fake semantic runtime (only ever used to *create* v4 fixtures) ──────────

const VERDICT_CHANGED = JSON.stringify({
  meaning_preserved: false,
  severity: 'major',
  negation: true,
  direction_location: false,
  instruction_action: false,
  critical_fact: false,
  domain_term: false,
  reason_codes: ['NEGATION'],
  short_rationale: 'Polarity reversed.',
});

const VERDICT_PRESERVED = JSON.stringify({
  meaning_preserved: true,
  severity: 'none',
  negation: false,
  direction_location: false,
  instruction_action: false,
  critical_fact: false,
  domain_term: false,
  reason_codes: ['SURFACE_ONLY'],
  short_rationale: 'Same instruction.',
});

const FACTS: SemanticRuntimeFacts = {
  endpoint_class: 'loopback',
  provider_protocol: SEMANTIC_PROVIDER_PROTOCOL,
  runtime: { name: 'Ollama', version: SEMANTIC_RUNTIME_VERSION },
  model: { id: SEMANTIC_MODEL_ID, digest: SEMANTIC_MODEL_DIGEST, quantization: SEMANTIC_MODEL_QUANTIZATION },
  prompt: { id: 'semantic-rubric-v1', sha256: SEMANTIC_RUBRIC_V1_SHA256 },
};

function fakeRunner(replies: string[]): SemanticRunner {
  let calls = 0;
  return {
    async preflight() {
      return FACTS;
    },
    async chat() {
      const reply = replies[calls] ?? '';
      calls += 1;
      return reply;
    },
  };
}

const UNREACHABLE_RUNNER: SemanticRunner = {
  async preflight() {
    throw new Error('the model must not be contacted');
  },
  async chat() {
    throw new Error('the model must not be contacted');
  },
};

// ── Stores and seeding ──────────────────────────────────────────────────────

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;
let evaluationsRoot: string;
let runStore: LocalRunStore;
let resultStore: LocalResultStore;
let sessionStore: LocalSessionStore;
let evaluationStore: LocalEvaluationStore;

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rep-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rep-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rep-sessions-'));
  evaluationsRoot = await mkdtemp(path.join(tmpdir(), 'vib-rep-evaluations-'));
  runStore = new LocalRunStore(runsRoot);
  resultStore = new LocalResultStore(resultsRoot);
  sessionStore = new LocalSessionStore(sessionsRoot);
  evaluationStore = new LocalEvaluationStore(evaluationsRoot);
  await runStore.saveRun(RUN_ID, {
    sourceText: SOURCE_TEXT,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifest(RUN_ID), null, 2)}\n`, 'utf8'),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Only the four stores: there is no semantic runner a report could reach. */
function stores(): RunComparisonDeps {
  return { runStore, resultStore, sessionStore, evaluationStore };
}

function evaluationDeps(overrides: Partial<EvaluationDeps> = {}): EvaluationDeps {
  return { ...stores(), now: () => NOW, ...overrides };
}

async function saveSealed(
  resultId: string,
  toolId: 'windows-standard-voice-input' | 'aqua-voice' | 'other',
  options: { transcript?: string; customToolName?: string; toolVersion?: string } = {},
): Promise<void> {
  await saveManualSttResult(
    {
      runId: RUN_ID,
      toolId,
      customToolName: options.customToolName ?? null,
      toolVersion: options.toolVersion ?? null,
      deliveryPath: 'speaker-to-mic',
      rawTranscript: options.transcript ?? TRANSCRIPT,
    },
    { runStore, resultStore, now: () => NOW, resultId },
  );
}

async function saveLegacy(resultId: string): Promise<void> {
  const legacy = {
    schema_version: 1,
    result_id: resultId,
    run_id: RUN_ID,
    captured_at: NOW.toISOString(),
    tool: {
      id: 'windows-standard-voice-input',
      name: BUILT_IN_TOOL_NAMES['windows-standard-voice-input'],
      version: null,
    },
    capture: { method: 'manual-paste', delivery_path: 'speaker-to-mic' },
    run_evidence: {
      manifest_schema_version: 2,
      test_id: 'numbers-units-001',
      source_sha256: sha(SOURCE_TEXT),
      audio_sha256: sha(AUDIO),
    },
    transcript: {
      file: 'transcript.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
      sha256: sha(TRANSCRIPT),
      bytes: Buffer.byteLength(TRANSCRIPT, 'utf8'),
    },
  };
  await resultStore.saveResult(resultId, {
    transcriptText: TRANSCRIPT,
    resultJson: Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, 'utf8'),
  });
}

async function evaluate(
  resultId: string,
  evaluatorId: EvaluatorId,
  evaluationId: string,
  semanticRunner?: SemanticRunner,
): Promise<void> {
  await createEvaluation(
    { resultId, evaluatorId },
    evaluationDeps({ evaluationId, ...(semanticRunner ? { semanticRunner } : {}) }),
  );
}

async function patchJson(file: string, mutate: (json: Record<string, unknown>) => void) {
  const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  mutate(json);
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
}

const evaluationFile = (id: string) => evaluationStore.resolveEvaluationFile(id);
const resultFile = (id: string) => resultStore.resolveResultFile(id, 'result.json');
const transcriptFile = (id: string) => resultStore.resolveResultFile(id, 'transcript.txt');
const runFile = (name: 'manifest.json' | 'source.txt' | 'audio.wav' | 'provider-query.json') =>
  runStore.resolveRunFile(RUN_ID, name);

/** Same JSON, different bytes: re-indented. Verification cannot see it; byte identity can. */
async function reindent(file: string): Promise<void> {
  const json = JSON.parse(await readFile(file, 'utf8')) as unknown;
  await writeFile(file, `${JSON.stringify(json, null, 4)}\n`);
}

function build(now = NOW): Promise<ReportPackage> {
  return buildReportPackage(stores(), RUN_ID, { now: () => now });
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

function verifiedSource(source: ReportSource, resultId: string): ReportVerifiedResultSource {
  const found = source.results.find((r) => r.result_id === resultId);
  if (!found || found.kind !== 'verified') throw new Error(`no verified ${resultId}`);
  return found;
}

/**
 * A ReportSource with an unattributed verified Evaluation (H): E1 verified on
 * R1, frozen from a reading whose Result listing did not contain R1. One
 * reading cannot produce that — the two listings would have to disagree — so
 * the reading is assembled by hand, and hashed from the real bytes on disk.
 */
async function unattributedVerifiedSource() {
  await saveSealed(R1, 'windows-standard-voice-input');
  await evaluate(R1, 'raw-char-v1', E1);
  const runEvidence = await verifyRunEvidence(runStore, RUN_ID);
  const evaluations = await listEvaluationsForRun(evaluationDeps(), RUN_ID);
  const comparison = assembleRunComparison({ runEvidence, results: [], evaluations });
  const reading = { runEvidence, results: [], evaluations, comparison };
  const source = reportSourceOf(reading, await hashCitedArtifacts(stores(), comparison));
  return { source, reading };
}

function groupOf(source: ReportSource, resultId: string, evaluatorId: EvaluatorId) {
  const found = verifiedSource(source, resultId).evaluation_groups.find((g) => g.evaluator_id === evaluatorId);
  if (!found) throw new Error('no group');
  return found;
}

/**
 * A Run exercising every container:
 * R1 windows (raw ×2, critical rejected), R2 aqua (Critical veto semantic),
 * R3 aqua rejected, R4 other rejected, R5 legacy, R6 legacy rejected,
 * R7 other custom; E9 rejected naming no Result.
 */
async function seedMixedRun(): Promise<void> {
  await saveSealed(R1, 'windows-standard-voice-input', { toolVersion: '24H2' });
  await saveSealed(R2, 'aqua-voice', { transcript: WRONG_VALUE_TRANSCRIPT });
  await saveSealed(R3, 'aqua-voice');
  await saveSealed(R4, 'other', { customToolName: 'Beta STT' });
  await saveLegacy(R5);
  await saveLegacy(R6);
  await saveSealed(R7, 'other', { customToolName: 'Alpha STT', toolVersion: '2.1' });
  await evaluate(R1, 'raw-char-v1', E1);
  await evaluate(R1, 'raw-char-v1', E2);
  await evaluate(R1, 'critical-info-v1', E3);
  await evaluate(R2, 'semantic-h3-v1', E4, UNREACHABLE_RUNNER);
  await evaluate(R3, 'raw-char-v1', E5);
  await evaluate(R4, 'raw-char-v1', E6);
  await evaluate(R7, 'surface-normalized-char-v1', E7);
  await evaluate(R7, 'raw-char-v1', E9);
  await patchJson(evaluationFile(E3), (json) => {
    (json.metrics as Record<string, unknown>).matched = 99;
  });
  await patchJson(evaluationFile(E9), (json) => {
    delete json.result_id;
  });
  await writeFile(transcriptFile(R3), '書き換え');
  await writeFile(transcriptFile(R4), '書き換え');
  await rm(transcriptFile(R6));
}

// ── Build ───────────────────────────────────────────────────────────────────

describe('buildReportPackage — ReportSource v1', () => {
  it('freezes every Result and Evaluation in exactly one container, as the comparison placed them', async () => {
    await seedMixedRun();
    const { report_source: source } = await build();

    expect(source.report_contract_version).toBe(1);
    expect(source.results.map((r) => [r.result_id, r.kind])).toEqual([
      [R1, 'verified'],
      [R2, 'verified'],
      [R3, 'rejected'],
      [R7, 'verified'],
    ]);
    expect(verifiedSource(source, R7).tool).toEqual({ kind: 'custom', id: 'other', trusted_name: 'Alpha STT' });
    expect(verifiedSource(source, R7).tool_version).toBe('2.1');
    expect(verifiedSource(source, R1).tool_version).toBe('24H2');
    expect(source.legacy_results.map((r) => [r.result_id, r.kind])).toEqual([
      [R5, 'legacy-unsealed-verified'],
      [R6, 'legacy-unsealed-rejected'],
    ]);
    expect(source.unattributed_results).toEqual([
      expect.objectContaining({ result_id: R4, reason_class: 'custom-tool-identity-unavailable' }),
    ]);
    expect(source.unattributed_rejected_evaluation_ids).toEqual([E9]);
    expect(source.unattributed_verified_evaluation_ids).toEqual([]);

    // The partition covers exactly what the listings return, once each.
    const partition = evaluationPartitionOf(source);
    const listed = await listEvaluationsForRun(evaluationDeps(), RUN_ID);
    expect([...partition.keys()].sort()).toEqual(listed.map((e) => e.evaluationId).sort());
    expect(partition.get(E3)).toEqual({ container: 'unclassified_rejected', result_id: R1 });
    expect(partition.get(E5)).toEqual({ container: 'unclassified_rejected', result_id: R3 });
    expect(partition.get(E6)).toEqual({ container: 'rejected_on_unattributed_result', result_id: R4 });
    const results = await listResultsForRun(stores(), RUN_ID);
    expect(Object.keys(source.artifact_content.results)).toEqual(results.map((r) => r.resultId).sort());
    expect(source.completeness).toEqual(completenessOf(source));
  });

  it('carries no version, capture or transcript for a rejected Result — absent, not null', async () => {
    await seedMixedRun();
    const { report_source: source } = await build();

    const rejected = source.results.find((r) => r.result_id === R3)!;
    expect(Object.keys(rejected).sort()).toEqual([
      'kind',
      'reason_at_report_time',
      'result_file_sha256',
      'result_id',
      'trusted_tool_id',
      'unclassified_rejected_evaluation_ids',
      'verified_evaluation_ids',
    ]);
    expect(rejected).toMatchObject({ trusted_tool_id: 'aqua-voice', reason_at_report_time: 'RESULT_TRANSCRIPT_HASH_MISMATCH' });
    const legacyRejected = source.legacy_results.find((r) => r.result_id === R6)!;
    expect(legacyRejected).not.toHaveProperty('claimed_tool_id');
    expect(legacyRejected).not.toHaveProperty('transcript_sha256');
  });

  it('freezes the SHA-256 of the actual file bytes, not of re-serialized JSON', async () => {
    await seedMixedRun();
    const first = await build();
    await reindent(evaluationFile(E1));
    const second = await build();

    const onDisk = sha(await readFile(evaluationFile(E1)));
    expect(second.report_source.artifact_content.evaluations[E1]!.file_sha256).toBe(onDisk);
    expect(first.report_source.artifact_content.evaluations[E1]!.file_sha256).not.toBe(onDisk);
    // Same meaning, still verified with the same seal — yet not the same evidence.
    expect(second.report_source.artifact_content.evaluations[E1]!.semantic_sha256).toBe(
      first.report_source.artifact_content.evaluations[E1]!.semantic_sha256,
    );
    expect(second.content_sha256).not.toBe(first.content_sha256);

    const runBytes = {
      manifest: sha(await readFile(runFile('manifest.json'))),
      source: sha(await readFile(runFile('source.txt'))),
      audio: sha(await readFile(runFile('audio.wav'))),
    };
    expect(second.report_source.run_evidence).toMatchObject({
      manifest_file_sha256: runBytes.manifest,
      source_sha256: runBytes.source,
      audio_sha256: runBytes.audio,
    });
    expect(verifiedSource(second.report_source, R1).transcript_sha256).toBe(sha(await readFile(transcriptFile(R1))));
    expect(second.report_source.artifact_content.results[R6]!.file_sha256).toBe(sha(await readFile(resultFile(R6))));
    // Every Result's transcript bytes are identified, including a rejected
    // Result's (a re-check reads them) and an absent one's (recorded as null).
    expect(second.report_source.artifact_content.results[R3]!.transcript_file_sha256).toBe(
      sha(await readFile(transcriptFile(R3))),
    );
    expect(second.report_source.artifact_content.results[R6]!.transcript_file_sha256).toBeNull();
    expect(second.report_source.artifact_content.results[R1]!.transcript_file_sha256).toBe(
      verifiedSource(second.report_source, R1).transcript_sha256,
    );
    // Every verified Evaluation names its subject; the rejected ones do not.
    expect(second.report_source.verified_evaluation_subjects).toEqual({
      [E1]: { subject_result_id: R1 },
      [E2]: { subject_result_id: R1 },
      [E4]: { subject_result_id: R2 },
      [E7]: { subject_result_id: R7 },
    });
    expect(second.report_source.supporting_results).toEqual({});
    // Canonical ids only: no path of any kind is frozen.
    const json = second.report_source_json;
    for (const root of [runsRoot, resultsRoot, evaluationsRoot, tmpdir()]) expect(json).not.toContain(root);
    expect(json).not.toContain('\\');
    expect(json).not.toMatch(/\.(json|txt|wav)"/);
  });

  it('keeps a verified Evaluation whose Result is missing from the listing in the unattributed_verified partition', async () => {
    const { source, reading } = await unattributedVerifiedSource();
    const bytes = await readFile(evaluationFile(E1));

    expect(source.unattributed_verified_evaluation_ids).toEqual([E1]);
    expect(evaluationPartitionOf(source).get(E1)).toEqual({ container: 'unattributed_verified' });
    expect(source.artifact_content.evaluations[E1]).toEqual({
      file_sha256: sha(bytes),
      semantic_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Its subject is frozen as supporting evidence only — not promoted into any
    // Result container.
    expect(source.verified_evaluation_subjects).toEqual({ [E1]: { subject_result_id: R1 } });
    expect(source.supporting_results).toEqual({
      [R1]: {
        result_file_sha256: sha(await readFile(resultFile(R1))),
        transcript_file_sha256: sha(await readFile(transcriptFile(R1))),
      },
    });
    expect(source.artifact_content.results).toEqual({});
    expect(source.results).toEqual([]);
    expect(validateReportSource(JSON.parse(JSON.stringify(source)))).toEqual(source);
    const body = renderReportBody(source, reading.comparison);
    expect(body).toContain('### Run-level unattributed verified Evaluations');
    expect(body).toContain(E1);
    expect(body).toContain(`| supporting result | \`${R1}\``);
  });

  it('refuses to freeze a verified Evaluation on a Result that did not verify: that cannot come from one reading', async () => {
    await saveSealed(R1, 'aqua-voice');
    await evaluate(R1, 'raw-char-v1', E1);
    const runEvidence = await verifyRunEvidence(runStore, RUN_ID);
    const evaluations = await listEvaluationsForRun(evaluationDeps(), RUN_ID);
    // A listing that disagrees with the Evaluation's own readback of R1.
    const results = [
      {
        status: 'rejected' as const,
        resultId: R1,
        reason: 'RESULT_TRANSCRIPT_HASH_MISMATCH',
        message: 'listing disagreed',
        trustedToolId: 'aqua-voice' as const,
        integrityTrust: 'sealed' as const,
      },
    ];
    const comparison = assembleRunComparison({ runEvidence, results, evaluations });
    expect(comparison.tools[0]!.results[0]).toMatchObject({ kind: 'rejected', verified_evaluations: [expect.anything()] });

    const hashes = await hashCitedArtifacts(stores(), comparison);
    expect(() => reportSourceOf({ runEvidence, results, evaluations, comparison }, hashes)).toThrow(
      expect.objectContaining({ kind: 'REPORT_EVIDENCE_CHANGED_DURING_BUILD' }),
    );
  });

  it('builds a valid, empty package for a Run with no Results', async () => {
    const report = await build();
    expect(report.report_source.results).toEqual([]);
    expect(report.report_source.artifact_content).toEqual({ results: {}, evaluations: {} });
    expect(report.report_source.completeness.state).toBe('partial');
    expect(report.markdown_body).toContain('tool 比較に使える sealed Result はありません。');
  });
});

describe('buildReportPackage — deterministic identity', () => {
  it('gives identical source, body and content_sha256 for identical evidence; only generated_at moves', async () => {
    await seedMixedRun();
    const a = await build(NOW);
    const b = await build(LATER);

    expect(b.report_source).toEqual(a.report_source);
    expect(b.report_source_json).toBe(a.report_source_json);
    expect(b.markdown_body).toBe(a.markdown_body);
    expect(b.content_sha256).toBe(a.content_sha256);
    expect(b.filenames).toEqual(a.filenames);
    expect(a.generated_at).toBe(NOW.toISOString());
    expect(b.generated_at).toBe(LATER.toISOString());
    expect(b.markdown).not.toBe(a.markdown);
  });

  it('defines content_sha256 over the ReportSource and the body only, with the footer separable', async () => {
    await seedMixedRun();
    // LATER, so the timestamp cannot coincide with a captured_at in the body.
    const report = await build(LATER);

    expect(report.content_sha256).toBe(reportContentSha256(report.report_source, report.markdown_body));
    const split = splitReportMarkdown(report.markdown);
    expect(split?.body).toBe(report.markdown_body);
    expect(split?.footer.startsWith(PRESENTATION_FOOTER_MARKER)).toBe(true);
    expect(split?.footer).toContain(report.content_sha256);
    expect(split?.footer).toContain(report.generated_at);
    expect(report.markdown_body).not.toContain(report.generated_at);
    expect(JSON.parse(report.report_source_json)).toEqual(report.report_source);
  });

  it('writes the body as UTF-8 text with LF only and exactly one trailing LF', async () => {
    await seedMixedRun();
    const { markdown_body: body, markdown } = await build();

    expect(body).not.toContain('\r');
    expect(markdown).not.toContain('\r');
    expect(body.endsWith('\n')).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
    expect(Buffer.from(body, 'utf8').toString('utf8')).toBe(body);
  });

  it('names the files from the Run id and the content hash only', async () => {
    const report = await build();
    const stem = `vib-report-${RUN_ID}-${report.content_sha256.slice(0, 12)}`;
    expect(report.filenames).toEqual({ source: `${stem}.source.json`, markdown: `${stem}.md` });
  });
});

describe('buildReportPackage — one generation only', () => {
  class MutatingEvaluationStore extends LocalEvaluationStore {
    calls = 0;
    constructor(
      root: string,
      private readonly onSecondListing: () => Promise<void>,
    ) {
      super(root);
    }
    override async listEvaluationIds(): Promise<string[]> {
      this.calls += 1;
      if (this.calls === 2) await this.onSecondListing();
      return super.listEvaluationIds();
    }
  }

  it('fails closed when a cited file changes between the two readings', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    const mutating = new MutatingEvaluationStore(evaluationsRoot, () => reindent(evaluationFile(E1)));

    const failure = await buildReportPackage({ ...stores(), evaluationStore: mutating }, RUN_ID).catch(
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(ReportError);
    expect((failure as ReportError).kind).toBe('REPORT_EVIDENCE_CHANGED_DURING_BUILD');
  });

  it('fails closed when a new Evaluation appears between the two readings', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    const mutating = new MutatingEvaluationStore(evaluationsRoot, () => evaluate(R1, 'raw-char-v1', E2));

    const failure = await buildReportPackage({ ...stores(), evaluationStore: mutating }, RUN_ID).catch(
      (caught: unknown) => caught,
    );

    expect((failure as ReportError).kind).toBe('REPORT_EVIDENCE_CHANGED_DURING_BUILD');
  });

  it('fails as a whole when the Run does not verify', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await writeFile(runFile('source.txt'), '別の文章。');
    await expect(build()).rejects.toMatchObject({ kind: 'RUN_HASH_MISMATCH' });
  });

  it('writes nothing to any storage root, and never touches the network', async () => {
    await seedMixedRun();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in a report'));
    const roots = [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot];
    const before = await Promise.all(roots.map(snapshot));

    const report = await build();
    await rerenderReport(stores(), JSON.parse(report.report_source_json));

    expect(await Promise.all(roots.map(snapshot))).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Markdown content ────────────────────────────────────────────────────────

describe('report.md body', () => {
  it('keeps the four layers separate, and every gap visible', async () => {
    await seedMixedRun();
    const { markdown_body: body } = await build();

    const sections = ['## Raw — `raw-char-v1`', '## Surface — `surface-normalized-char-v1`', '## Critical — `critical-info-v1`', '## Semantic — `semantic-h3-v1`'];
    const positions = sections.map((heading) => body.indexOf(heading));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    for (const heading of [
      '### Missing evaluators',
      '### Rejected Result evidence',
      '### Rejected / unclassified Evaluations (Result known)',
      '### Legacy unsealed Results',
      '### Unattributed Results',
      '### Run-level unattributed rejected Evaluations',
      '### Run-level unattributed verified Evaluations',
      '## Artifact content identity',
    ]) {
      expect(body).toContain(heading);
    }
    for (const id of [R1, R2, R3, R4, R5, R6, R7, E1, E2, E3, E4, E5, E6, E7, E9]) expect(body).toContain(id);
    expect(body).toContain('**MISSING**');
    // Coverage is a coverage reading, not a health verdict.
    expect(body).toContain('- Verified evaluator coverage: **partial**');
    expect(body).not.toContain('- State:');
    expect(body).toContain('- Version: `24H2`');
    expect(body).toContain('- Delivery path: `speaker-to-mic`');
    expect(body).not.toMatch(GRADE_WORDS);
    expect(body).not.toMatch(SYNTHESIS_WORDS);
  });

  it('states the Critical-veto route and carries the self-correction limitation', async () => {
    await seedMixedRun();
    const { markdown_body: body } = await build();

    expect(body).toContain('- Decision: **CHANGED** (`changed`)');
    expect(body).toContain('`critical-guard-veto-v1`');
    expect(body).toContain('`skipped_by_critical_veto` · runs recorded 0');
    expect(body).toContain(CRITICAL_VETO_ROUTE_NOTE);
    expect(body).toContain(SELF_CORRECTION_LIMITATION_NOTE);
  });

  it('renders a full-run-unanimous preserved outcome as REVIEW REQUIRED', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'semantic-h3-v1', E1, fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]));
    const { markdown_body: body } = await build();

    expect(body).toContain('- Decision: **REVIEW REQUIRED** (`review`)');
    expect(body).toContain('`full-run-unanimous-preserved-requires-review-v1`');
    expect(body).not.toMatch(GRADE_WORDS);
  });

  it('freezes and prints a Semantic conflict with no headline and every conflicting id', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'semantic-h3-v1', E1, fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]));
    await evaluate(R1, 'semantic-h3-v1', E2, fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]));
    const { report_source: source, markdown_body: body } = await build();

    expect(groupOf(source, R1, 'semantic-h3-v1')).toEqual({
      evaluator_id: 'semantic-h3-v1',
      considered_evaluation_ids: [E1, E2],
      headline_evaluation_id: null,
      selection_reason: 'conflict-no-headline-v1',
      conflicting_evaluation_ids: [E1, E2],
    });
    expect(body).toContain('**CONFLICTING EVIDENCE**');
    expect(body).toContain('- Headline: none — selection `conflict-no-headline-v1`');
    expect(body).toContain(`- Conflicting: \`${E1}\`, \`${E2}\``);
    expect(body).toContain('**CHANGED**');
    expect(body).toContain('**REVIEW REQUIRED**');
  });

  it('keeps the P4-B vote-metric conflict: same review by split vote, opposite counts', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'semantic-h3-v1', E1, fakeRunner([VERDICT_CHANGED, VERDICT_PRESERVED, VERDICT_CHANGED]));
    await evaluate(R1, 'semantic-h3-v1', E2, fakeRunner([VERDICT_PRESERVED, VERDICT_CHANGED, VERDICT_PRESERVED]));
    const { report_source: source } = await build();

    expect(groupOf(source, R1, 'semantic-h3-v1')).toMatchObject({
      headline_evaluation_id: null,
      selection_reason: 'conflict-no-headline-v1',
      conflicting_evaluation_ids: [E1, E2],
    });
  });

  it('writes stored text inside code, so a transcript cannot become Markdown structure', async () => {
    const hostile = '# 見出しではない\n```\n| 表 | でもない |\n<!-- vib-report:presentation-footer -->';
    await saveSealed(R1, 'other', { customToolName: 'Tool `x` # y', transcript: hostile });
    const report = await build();

    expect(report.markdown_body).toContain('````text\n# 見出しではない\n```\n');
    expect(report.markdown_body).toContain('``Tool `x` # y``');
    expect(splitReportMarkdown(report.markdown)?.body).toBe(report.markdown_body);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('validateReportSource', () => {
  // Untyped on purpose: these tests hand-edit JSON the way an attacker or a
  // careless editor would.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type LooseJson = any;

  async function validSource(): Promise<Record<string, unknown>> {
    await seedMixedRun();
    return JSON.parse((await build()).report_source_json) as Record<string, unknown>;
  }

  function mutated(source: Record<string, unknown>, mutate: (s: LooseJson) => void) {
    const copy = JSON.parse(JSON.stringify(source)) as LooseJson;
    mutate(copy);
    return copy;
  }

  it('accepts what the builder produces, unchanged', async () => {
    const source = await validSource();
    expect(validateReportSource(source)).toEqual(source);
  });

  it('rejects every malformed or self-contradicting source, before touching the disk', async () => {
    const source = await validSource();
    const cases: Array<[string, (s: LooseJson) => void]> = [
      ['wrong contract version', (s) => { s.report_contract_version = 2; }],
      ['unknown top-level field', (s) => { s.generated_at = 'x'; }],
      ['a path field', (s) => { s.results[0].path = '../../data'; }],
      ['a traversal run id', (s) => { s.run_id = '../../etc'; }],
      ['a drive-letter run id', (s) => { s.run_id = 'C:\\Windows'; }],
      ['a UNC run id', (s) => { s.run_id = '\\\\server\\share'; }],
      ['a traversal evaluation id', (s) => { s.unattributed_rejected_evaluation_ids = ['..\\x']; }],
      ['a malformed hash', (s) => { s.run_evidence.audio_sha256 = 'abc'; }],
      ['a duplicate Evaluation across containers', (s) => { s.unattributed_rejected_evaluation_ids = [E1, E9]; }],
      ['an Evaluation with no content entry', (s) => { delete s.artifact_content.evaluations[E9]; }],
      ['a content entry in no container', (s) => { s.artifact_content.evaluations['20260911T030000000Z-ffffffff'] = { file_sha256: 'a'.repeat(64) }; }],
      ['a Result with no content entry', (s) => { delete s.artifact_content.results[R5]; }],
      ['a Result hash disagreeing with its content entry', (s) => { s.results[0].result_file_sha256 = 'f'.repeat(64); }],
      ['a headline outside its candidates', (s) => { s.results[0].evaluation_groups[0].headline_evaluation_id = E9; }],
      ['a stale headline (not the newest)', (s) => { s.results[0].evaluation_groups[0].headline_evaluation_id = E1; }],
      ['a conflict with a headline', (s) => {
        const g = s.results[0].evaluation_groups[0];
        g.selection_reason = 'conflict-no-headline-v1';
        g.conflicting_evaluation_ids = g.considered_evaluation_ids;
      }],
      ['evaluator groups out of order', (s) => { s.results[0].evaluation_groups.reverse(); }],
      ['an unknown selection reason', (s) => { s.results[0].evaluation_groups[0].selection_reason = 'majority-v1'; }],
      ['a rejected Result carrying a version', (s) => {
        const rejected = s.results.find((r: LooseJson) => r.kind === 'rejected');
        rejected.tool_version = '1.0';
      }],
      ['a rejected Result attributed to other', (s) => {
        const rejected = s.results.find((r: LooseJson) => r.kind === 'rejected');
        rejected.trusted_tool_id = 'other';
      }],
      ['a seal hash on a rejected Evaluation', (s) => { s.artifact_content.evaluations[E9].semantic_sha256 = 'a'.repeat(64); }],
      ['no seal hash on a verified Evaluation', (s) => { delete s.artifact_content.evaluations[E1].semantic_sha256; }],
      ['unsorted candidate ids', (s) => { s.results[0].evaluation_groups[0].considered_evaluation_ids.reverse(); }],
      ['Results out of tool order', (s) => { s.results.reverse(); }],
      ['a completeness that does not match the structure', (s) => { s.completeness.legacy_unsealed_results = 0; }],
      ['a different ordering rule', (s) => { s.ordering.headline = 'majority-v1'; }],
      ['an unknown reason class', (s) => { s.unattributed_results[0].reason_class = 'guessed'; }],
      ['a legacy claim marked as verified', (s) => {
        const legacy = s.legacy_results.find((r: LooseJson) => r.kind === 'legacy-unsealed-verified');
        legacy.tool_claim_is_unverified = false;
      }],
      // RF-1: every verified Evaluation's subject is frozen, exactly once, and nothing else is.
      ['a verified Evaluation with no subject', (s) => { delete s.verified_evaluation_subjects[E1]; }],
      ['a subject that is not the Evaluation\'s own Result', (s) => { s.verified_evaluation_subjects[E1].subject_result_id = R7; }],
      ['a subject on a rejected Evaluation', (s) => { s.verified_evaluation_subjects[E9] = { subject_result_id: R1 }; }],
      ['a subject with a path', (s) => { s.verified_evaluation_subjects[E1].path = '../../results'; }],
      ['a subject that is not a Result id', (s) => { s.verified_evaluation_subjects[E1].subject_result_id = 'C:\\data'; }],
      ['an unused supporting Result', (s) => {
        s.supporting_results['20260911T019900000Z-0000000a'] = { result_file_sha256: 'a'.repeat(64), transcript_file_sha256: 'b'.repeat(64) };
      }],
      ['a supporting Result duplicating a container Result', (s) => {
        s.supporting_results[R1] = { result_file_sha256: 'a'.repeat(64), transcript_file_sha256: 'b'.repeat(64) };
      }],
      ['a transcript hash contradicting the verified Result', (s) => { s.artifact_content.results[R1].transcript_file_sha256 = 'f'.repeat(64); }],
      ['a Result with no transcript identity', (s) => { delete s.artifact_content.results[R3].transcript_file_sha256; }],
      ...(['rejected', 'legacy', 'unattributed'] as const).map((where): [string, (s: LooseJson) => void] => [
        `a verified Evaluation on a ${where} Result (cannot come from one reading)`,
        (s) => {
          const id = '20260911T029900000Z-0000000b';
          s.artifact_content.evaluations[id] = { file_sha256: 'a'.repeat(64), semantic_sha256: 'b'.repeat(64) };
          s.verified_evaluation_subjects[id] = { subject_result_id: where === 'rejected' ? R3 : where === 'legacy' ? R5 : R4 };
          if (where === 'rejected') s.results.find((r: LooseJson) => r.result_id === R3).verified_evaluation_ids = [id];
          if (where === 'legacy') s.legacy_results.find((r: LooseJson) => r.result_id === R5).verified_evaluation_ids = [id];
          if (where === 'unattributed') s.unattributed_results[0].related_verified_evaluation_ids = [id];
        },
      ]),
    ];
    for (const [name, mutate] of cases) {
      const failure = (() => {
        try {
          validateReportSource(mutated(source, mutate));
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(failure, name).toBeInstanceOf(ReportError);
      expect((failure as ReportError).kind, name).toBe('REPORT_SOURCE_INVALID');
    }
    for (const notAnObject of [null, [], 'x', 1]) {
      expect(() => validateReportSource(notAnObject)).toThrow(ReportError);
    }
  });
});

// ── Re-render ───────────────────────────────────────────────────────────────

describe('rerenderReport', () => {
  async function exported(): Promise<{ report: ReportPackage; source: unknown }> {
    const report = await build();
    return { report, source: JSON.parse(report.report_source_json) as unknown };
  }

  it('reproduces the same body and content_sha256 when nothing changed', async () => {
    await seedMixedRun();
    const { report, source } = await exported();

    const outcome = await rerenderReport(stores(), source, { now: () => LATER });

    expect(outcome.status).toBe('reproduced');
    expect(outcome.evidence_changed).toEqual([]);
    expect(outcome.verification_changed).toEqual([]);
    expect(outcome.not_rechecked).toEqual([]);
    expect(outcome.markdown_body).toBe(report.markdown_body);
    expect(outcome.content_sha256).toBe(report.content_sha256);
  });

  it('never lets an Evaluation created after the report join it', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    const { report, source } = await exported();
    // Newer id, same Result, same evaluator: it would be the newest headline.
    await evaluate(R1, 'raw-char-v1', E5);

    const outcome = await rerenderReport(stores(), source);

    expect(outcome.status).toBe('reproduced');
    expect(outcome.content_sha256).toBe(report.content_sha256);
    expect(outcome.markdown_body).not.toContain(E5);
    expect(groupOf(outcome.report_source, R1, 'raw-char-v1')).toMatchObject({
      considered_evaluation_ids: [E1],
      headline_evaluation_id: E1,
    });
    // Only a new live report sees it.
    const live = await build();
    expect(groupOf(live.report_source, R1, 'raw-char-v1')).toMatchObject({
      considered_evaluation_ids: [E1, E5],
      headline_evaluation_id: E5,
    });
  });

  it.each([
    ['manifest.json', 'manifest'],
    ['source.txt', 'source'],
    ['audio.wav', 'audio'],
  ] as const)('fails as a whole when the Run basis %s changed — evidence, not verification', async (file, kind) => {
    await seedMixedRun();
    const { source } = await exported();
    const target = runFile(file);
    const expected = sha(await readFile(target));
    await writeFile(target, file === 'manifest.json' ? `${(await readFile(target, 'utf8')).trimEnd()}\n\n` : 'changed bytes');

    const failure = (await rerenderReport(stores(), source).catch((caught: unknown) => caught)) as ReportError;

    expect(failure).toBeInstanceOf(ReportError);
    expect(failure.kind).toBe('REPORT_RUN_BASIS_CHANGED');
    expect(failure.evidenceChanged).toEqual([
      {
        artifact_kind: kind,
        artifact_id: RUN_ID,
        expected_sha256: expected,
        actual_sha256: sha(await readFile(target)),
        change: 'modified',
      },
    ]);
    expect(failure.message).not.toContain(SOURCE_TEXT);
  });

  it('reports a missing Run basis file as missing', async () => {
    await seedMixedRun();
    const { source } = await exported();
    await rm(runFile('audio.wav'));

    const failure = (await rerenderReport(stores(), source).catch((caught: unknown) => caught)) as ReportError;
    expect(failure.kind).toBe('REPORT_RUN_BASIS_CHANGED');
    expect(failure.evidenceChanged).toEqual([
      expect.objectContaining({ artifact_kind: 'audio', actual_sha256: null, change: 'missing' }),
    ]);
  });

  it('reports a changed result.json as evidence, and does not re-check what stands on it', async () => {
    await seedMixedRun();
    const { source } = await exported();
    const expected = sha(await readFile(resultFile(R1)));
    await reindent(resultFile(R1));

    const outcome = await rerenderReport(stores(), source);

    expect(outcome.status).toBe('changed');
    expect(outcome.evidence_changed).toEqual([
      {
        artifact_kind: 'result',
        artifact_id: R1,
        expected_sha256: expected,
        actual_sha256: sha(await readFile(resultFile(R1))),
        change: 'modified',
      },
    ]);
    // Same meaning, still verifiable — but the bytes moved, so no verifier verdict is offered.
    expect(outcome.verification_changed).toEqual([]);
    expect(outcome.not_rechecked.map((n) => n.artifact_id).sort()).toEqual([E1, E2, E3]);
    expect(outcome.markdown_body).toContain('## Re-render findings');
  });

  it('reports a changed transcript.txt as evidence, not as the verifier now rejecting the Result', async () => {
    await seedMixedRun();
    const { source } = await exported();
    await writeFile(transcriptFile(R7), '別の transcript');

    const outcome = await rerenderReport(stores(), source);

    expect(outcome.evidence_changed).toEqual([
      expect.objectContaining({ artifact_kind: 'transcript', artifact_id: R7, change: 'modified' }),
    ]);
    expect(outcome.verification_changed).toEqual([]);
    expect(outcome.not_rechecked.map((n) => n.artifact_id)).toEqual([E7]);
  });

  it('reports a changed or missing evaluation.json as evidence', async () => {
    await seedMixedRun();
    const { source } = await exported();
    await reindent(evaluationFile(E2));
    await rm(evaluationFile(E7), { force: true });

    const outcome = await rerenderReport(stores(), source);

    expect(outcome.evidence_changed).toEqual([
      expect.objectContaining({ artifact_kind: 'evaluation', artifact_id: E2, change: 'modified' }),
      expect.objectContaining({ artifact_kind: 'evaluation', artifact_id: E7, change: 'missing', actual_sha256: null }),
    ]);
    // E2 left R1's raw group, so that group cannot be compared as a verifier change.
    expect(outcome.verification_changed).toEqual([]);
    expect(outcome.status).toBe('changed');
  });

  it('reports a verifier outcome change on unchanged bytes separately from evidence', async () => {
    await seedMixedRun();
    const { source } = await exported();

    const outcome = await rerenderReport(
      {
        ...stores(),
        verifiers: {
          evaluation: async (deps, evaluationId, stored, reader) =>
            evaluationId === E2
              ? {
                  status: 'rejected',
                  evaluationId,
                  resultId: R1,
                  reason: 'EVALUATION_METRICS_MISMATCH',
                  message: 'a hardened verifier now rejects these same bytes',
                }
              : verifyEvaluationListEntry(deps, evaluationId, stored, reader),
        },
      },
      source,
    );

    expect(outcome.status).toBe('changed');
    expect(outcome.evidence_changed).toEqual([]);
    expect(outcome.verification_changed).toEqual([
      {
        artifact_kind: 'evaluation',
        artifact_id: E2,
        report_time: { container: 'evaluator_group', result_id: R1, evaluator_id: 'raw-char-v1' },
        current: { container: 'unclassified_rejected', result_id: R1 },
        current_reason: 'EVALUATION_METRICS_MISMATCH',
      },
      {
        artifact_kind: 'evaluator_group',
        artifact_id: `${R1}/raw-char-v1`,
        report_time: {
          considered_evaluation_ids: [E1, E2],
          headline_evaluation_id: E2,
          selection_reason: 'newest-verified-by-id-v1',
        },
        current: {
          considered_evaluation_ids: [E1],
          headline_evaluation_id: E1,
          selection_reason: 'only-verified-entry-v1',
        },
      },
    ]);
    expect(outcome.markdown_body).toContain('### Verification changed (same bytes, different current outcome)');
  });

  it('reports a Result the current verifier places differently as a verification change', async () => {
    await seedMixedRun();
    const { source } = await exported();

    const outcome = await rerenderReport(
      {
        ...stores(),
        verifiers: {
          result: async (input) => ({
            status: 'rejected',
            resultId: input.resultId,
            reason: 'RESULT_TOOL_CONTRACT_MISMATCH',
            message: 'test double',
          }),
        },
      },
      source,
    );

    const resultChanges = outcome.verification_changed.filter((c) => c.artifact_kind === 'result');
    expect(resultChanges.map((c) => c.artifact_id)).toEqual([R1, R2, R3, R4, R5, R6, R7]);
    expect(resultChanges[0]).toMatchObject({
      report_time: { container: 'tool_group', kind: 'verified' },
      current: { container: 'unattributed', reason_class: 'tool-identity-unverified' },
      current_reason: 'RESULT_TOOL_CONTRACT_MISMATCH',
    });
    expect(outcome.evidence_changed).toEqual([]);
  });

  it('fails as a whole when the Run files held but the current verifier rejects the Run', async () => {
    await seedMixedRun();
    const { source } = await exported();
    // provider-query.json is verified by the Run check but not frozen by the report.
    await writeFile(runFile('provider-query.json'), '{"changed":true}\n');

    await expect(rerenderReport(stores(), source)).rejects.toMatchObject({
      kind: 'REPORT_RUN_VERIFICATION_CHANGED',
    });
  });

  it('refuses a source that contradicts the manifest it froze', async () => {
    await seedMixedRun();
    const { source } = await exported();
    (source as { run_evidence: { test_id: string } }).run_evidence.test_id = 'another-case';

    await expect(rerenderReport(stores(), source)).rejects.toMatchObject({ kind: 'REPORT_SOURCE_INVALID' });
  });

  it('refuses an invalid source without reading anything', async () => {
    await seedMixedRun();
    const { source } = await exported();
    (source as { run_id: string }).run_id = '..\\..\\outside';
    const readSpy = vi.spyOn(runStore, 'resolveRunFile');

    await expect(rerenderReport(stores(), source)).rejects.toMatchObject({ kind: 'REPORT_SOURCE_INVALID' });
    expect(readSpy).not.toHaveBeenCalled();
  });
});

// ── RF-1: frozen subject dependencies ───────────────────────────────────────

describe('rerenderReport — every Evaluation re-checks against frozen subject bytes only', () => {
  it('reproduces an unattributed verified Evaluation from its frozen supporting subject', async () => {
    const { source } = await unattributedVerifiedSource();
    const exported = JSON.parse(JSON.stringify(source)) as unknown;

    const first = await rerenderReport(stores(), exported);
    const second = await rerenderReport(stores(), exported, { now: () => LATER });

    expect(first.status).toBe('reproduced');
    expect(first.evidence_changed).toEqual([]);
    expect(first.verification_changed).toEqual([]);
    expect(first.not_rechecked).toEqual([]);
    expect(second.content_sha256).toBe(first.content_sha256);
    expect(first.markdown_body).toContain('### Run-level unattributed verified Evaluations');
  });

  it('reports a changed supporting result.json as evidence, and does not re-check the Evaluation on it', async () => {
    const { source } = await unattributedVerifiedSource();
    const exported = JSON.parse(JSON.stringify(source)) as unknown;
    const expected = sha(await readFile(resultFile(R1)));
    await reindent(resultFile(R1));

    const outcome = await rerenderReport(stores(), exported);

    expect(outcome.status).toBe('changed');
    expect(outcome.evidence_changed).toEqual([
      {
        artifact_kind: 'supporting_result',
        artifact_id: R1,
        expected_sha256: expected,
        actual_sha256: sha(await readFile(resultFile(R1))),
        change: 'modified',
      },
    ]);
    expect(outcome.not_rechecked).toEqual([
      { artifact_kind: 'evaluation', artifact_id: E1, because: 'subject_result_evidence_changed', subject_result_id: R1 },
    ]);
    expect(outcome.verification_changed).toEqual([]);
  });

  it('reports a changed supporting transcript.txt as evidence, and does not re-check the Evaluation on it', async () => {
    const { source } = await unattributedVerifiedSource();
    const exported = JSON.parse(JSON.stringify(source)) as unknown;
    await writeFile(transcriptFile(R1), '別の transcript');

    const outcome = await rerenderReport(stores(), exported);

    expect(outcome.evidence_changed).toEqual([
      expect.objectContaining({ artifact_kind: 'supporting_transcript', artifact_id: R1, change: 'modified' }),
    ]);
    expect(outcome.not_rechecked.map((n) => n.artifact_id)).toEqual([E1]);
    expect(outcome.verification_changed).toEqual([]);
  });

  it('never reads a Result, transcript or Evaluation the ReportSource did not name', async () => {
    const { source } = await unattributedVerifiedSource();
    const exported = JSON.parse(JSON.stringify(source)) as unknown;
    // Later, unrelated evidence — and a newer Evaluation of the same subject.
    await saveSealed(R2, 'aqua-voice');
    await evaluate(R2, 'raw-char-v1', E2);
    await evaluate(R1, 'raw-char-v1', E3);
    const resultFiles = vi.spyOn(resultStore, 'resolveResultFile');
    const evaluationFiles = vi.spyOn(evaluationStore, 'resolveEvaluationFile');
    const storeReads = [
      vi.spyOn(resultStore, 'readResult'),
      vi.spyOn(resultStore, 'readTranscript'),
      vi.spyOn(evaluationStore, 'readEvaluation'),
    ];

    const outcome = await rerenderReport(stores(), exported);

    expect(outcome.status).toBe('reproduced');
    expect(new Set(resultFiles.mock.calls.map(([id]) => id))).toEqual(new Set([R1]));
    expect(new Set(evaluationFiles.mock.calls.map(([id]) => id))).toEqual(new Set([E1]));
    // Subjects are served from the bytes just matched, never through the stores.
    for (const read of storeReads) expect(read).not.toHaveBeenCalled();
    for (const later of [R2, E2, E3]) expect(outcome.markdown_body).not.toContain(later);
  });

  it('re-checks Evaluations on a rejected Result from that Result\'s frozen transcript, without a store read', async () => {
    await seedMixedRun();
    const report = await build();
    const frozenResults = new Set(Object.keys(report.report_source.artifact_content.results));
    const resultFiles = vi.spyOn(resultStore, 'resolveResultFile');
    const readTranscript = vi.spyOn(resultStore, 'readTranscript');

    const outcome = await rerenderReport(stores(), JSON.parse(report.report_source_json));

    expect(outcome.status).toBe('reproduced');
    expect(outcome.content_sha256).toBe(report.content_sha256);
    for (const [id] of resultFiles.mock.calls) expect(frozenResults.has(id)).toBe(true);
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it('treats a rejected Result\'s changed transcript as evidence, and its Evaluations as not re-checked', async () => {
    await seedMixedRun();
    const report = await build();
    await writeFile(transcriptFile(R3), 'もう一度書き換え');

    const outcome = await rerenderReport(stores(), JSON.parse(report.report_source_json));

    expect(outcome.evidence_changed).toEqual([
      expect.objectContaining({ artifact_kind: 'transcript', artifact_id: R3, change: 'modified' }),
    ]);
    expect(outcome.not_rechecked.map((n) => n.artifact_id)).toEqual([E5]);
    expect(outcome.verification_changed).toEqual([]);
  });

  it('treats a transcript that appeared after the report as evidence', async () => {
    await seedMixedRun();
    const report = await build();
    await writeFile(transcriptFile(R6), TRANSCRIPT);

    const outcome = await rerenderReport(stores(), JSON.parse(report.report_source_json));

    expect(outcome.evidence_changed).toEqual([
      { artifact_kind: 'transcript', artifact_id: R6, expected_sha256: null, actual_sha256: sha(TRANSCRIPT), change: 'appeared' },
    ]);
    expect(outcome.verification_changed).toEqual([]);
  });
});

// ── RF-2: seal claims bound to the frozen bytes ─────────────────────────────

describe('rerenderReport — seal hashes in the ReportSource must be the seals in its bytes', () => {
  async function exportedMixed(): Promise<Record<string, unknown>> {
    await seedMixedRun();
    return JSON.parse((await build()).report_source_json) as Record<string, unknown>;
  }

  it('refuses a verified Result whose result_semantic_sha256 is not the seal in its unchanged bytes', async () => {
    const source = (await exportedMixed()) as unknown as { results: Array<Record<string, unknown>> };
    const r1 = source.results.find((r) => r.result_id === R1)!;
    r1.result_semantic_sha256 = 'f'.repeat(64);

    // Syntactically valid: only the bytes can tell.
    expect(() => validateReportSource(source)).not.toThrow();
    const failure = await rerenderReport(stores(), source).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ReportError);
    expect((failure as ReportError).kind).toBe('REPORT_SOURCE_INVALID');
  });

  it('refuses a verified Evaluation whose semantic_sha256 is not the seal in its unchanged bytes', async () => {
    const source = (await exportedMixed()) as unknown as {
      artifact_content: { evaluations: Record<string, { semantic_sha256?: string }> };
    };
    source.artifact_content.evaluations[E4]!.semantic_sha256 = '0'.repeat(64);

    expect(() => validateReportSource(source)).not.toThrow();
    await expect(rerenderReport(stores(), source)).rejects.toMatchObject({ kind: 'REPORT_SOURCE_INVALID' });
  });

  it('checks the seal only once the bytes hold: moved bytes stay an evidence change', async () => {
    const source = (await exportedMixed()) as unknown as {
      artifact_content: { evaluations: Record<string, { semantic_sha256?: string }> };
    };
    source.artifact_content.evaluations[E1]!.semantic_sha256 = '0'.repeat(64);
    await reindent(evaluationFile(E1));

    const outcome = await rerenderReport(stores(), source);

    expect(outcome.status).toBe('changed');
    expect(outcome.evidence_changed).toEqual([
      expect.objectContaining({ artifact_kind: 'evaluation', artifact_id: E1, change: 'modified' }),
    ]);
  });
});