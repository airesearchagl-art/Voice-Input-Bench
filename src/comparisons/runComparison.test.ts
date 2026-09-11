import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalSessionStore } from '@/storage/LocalSessionStore';
import { LocalEvaluationStore } from '@/storage/LocalEvaluationStore';
import { saveManualSttResult } from '@/results/saveResult';
import { listResultsForRun } from '@/results/saveResult';
import { RunEvidenceError, verifyRunEvidence } from '@/results/runEvidence';
import { BUILT_IN_TOOL_NAMES } from '@/results/tools';
import {
  EVALUATOR_IDS,
  createEvaluation,
  listEvaluationsForRun,
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
import { semanticVerdictLabel } from '@/app/runComparisonCopy';
import {
  assembleRunComparison,
  buildRunComparison,
  type ComparisonEvaluationGroup,
  type ComparisonRun,
  type ComparisonVerifiedResult,
  type SemanticSummary,
} from './runComparison';

/**
 * Run Comparison against real artifacts.
 *
 * Every Run, Result and Evaluation here is written by the production writers
 * and read back by the production verifiers. Rejected artifacts are made the
 * way they happen in practice — by editing bytes on disk after the fact — so
 * what the comparison is tested against is exactly what the listings return,
 * not a hand-built imitation of it.
 */

const RUN_ID = '20260910T010000000Z-aaaaaaaa';
const OTHER_RUN_ID = '20260910T010000000Z-abababab';
const NOW = new Date('2026-09-10T01:00:00.000Z');

const SOURCE_TEXT = '天井高は二千七百ミリを確保してください。';
const TRANSCRIPT = '天井高は2700ミリを確保してください。';
/** The same sentence with the wrong number: a supported Critical mismatch. */
const WRONG_VALUE_TRANSCRIPT = '天井高は2600ミリを確保してください。';
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

// Result ids ascend in the order they are listed here.
const R1 = '20260910T010100000Z-00000001';
const R2 = '20260910T010200000Z-00000002';
const R3 = '20260910T010300000Z-00000003';
const R4 = '20260910T010400000Z-00000004';
const R5 = '20260910T010500000Z-00000005';
const R_ABSENT = '20260910T010900000Z-0000000f';

// Evaluation ids ascend in the order they are listed here.
const E1 = '20260910T020100000Z-e0000001';
const E2 = '20260910T020200000Z-e0000002';
const E3 = '20260910T020300000Z-e0000003';
const E4 = '20260910T020400000Z-e0000004';
const E5 = '20260910T020500000Z-e0000005';

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

// ── Fake semantic runtime (the pinned facts, canned replies) ────────────────

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
  model: {
    id: SEMANTIC_MODEL_ID,
    digest: SEMANTIC_MODEL_DIGEST,
    quantization: SEMANTIC_MODEL_QUANTIZATION,
  },
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

/** A runner that fails the test if it is ever reached. */
const UNREACHABLE_RUNNER: SemanticRunner = {
  async preflight() {
    throw new Error('the model must not be contacted on this route');
  },
  async chat() {
    throw new Error('the model must not be contacted on this route');
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
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-cmp-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-cmp-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-cmp-sessions-'));
  evaluationsRoot = await mkdtemp(path.join(tmpdir(), 'vib-cmp-evaluations-'));
  runStore = new LocalRunStore(runsRoot);
  resultStore = new LocalResultStore(resultsRoot);
  sessionStore = new LocalSessionStore(sessionsRoot);
  evaluationStore = new LocalEvaluationStore(evaluationsRoot);
  await writeRun(RUN_ID);
});

afterEach(async () => {
  for (const root of [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

function deps(overrides: Partial<EvaluationDeps> = {}): EvaluationDeps {
  return { runStore, resultStore, sessionStore, evaluationStore, now: () => NOW, ...overrides };
}

async function writeRun(runId: string): Promise<void> {
  await runStore.saveRun(runId, {
    sourceText: SOURCE_TEXT,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifest(runId), null, 2)}\n`, 'utf8'),
  });
}

async function saveSealed(
  resultId: string,
  toolId: 'windows-standard-voice-input' | 'aqua-voice' | 'other',
  options: { transcript?: string; customToolName?: string; toolVersion?: string; runId?: string } = {},
): Promise<void> {
  await saveManualSttResult(
    {
      runId: options.runId ?? RUN_ID,
      toolId,
      customToolName: options.customToolName ?? null,
      toolVersion: options.toolVersion ?? null,
      deliveryPath: 'speaker-to-mic',
      rawTranscript: options.transcript ?? TRANSCRIPT,
    },
    { runStore, resultStore, now: () => NOW, resultId },
  );
}

/** A P2-A Result: schema v1, no seal. Written byte-for-byte, as P2-A wrote them. */
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
    deps({ evaluationId, ...(semanticRunner ? { semanticRunner } : {}) }),
  );
}

async function patchJson(file: string, mutate: (json: Record<string, unknown>) => void) {
  const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  mutate(json);
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
}

function patchEvaluation(evaluationId: string, mutate: (json: Record<string, unknown>) => void) {
  return patchJson(evaluationStore.resolveEvaluationFile(evaluationId), mutate);
}

function patchResult(resultId: string, mutate: (json: Record<string, unknown>) => void) {
  return patchJson(resultStore.resolveResultFile(resultId, 'result.json'), mutate);
}

async function overwriteTranscript(resultId: string): Promise<void> {
  await writeFile(resultStore.resolveResultFile(resultId, 'transcript.txt'), '書き換え');
}

async function removeTranscript(resultId: string): Promise<void> {
  await rm(resultStore.resolveResultFile(resultId, 'transcript.txt'), { force: true });
}

function build(): Promise<ComparisonRun> {
  return buildRunComparison(deps(), RUN_ID);
}

// ── Reading the model back ──────────────────────────────────────────────────

function toolKeys(comparison: ComparisonRun): string[] {
  return comparison.tools.map((group) =>
    group.tool.kind === 'built-in' ? group.tool.id : `other:${group.tool.trusted_name}`,
  );
}

function verifiedResult(comparison: ComparisonRun, resultId: string): ComparisonVerifiedResult {
  for (const group of comparison.tools) {
    for (const result of group.results) {
      if (result.result_id === resultId && result.kind === 'verified') return result;
    }
  }
  throw new Error(`no verified tool-grouped Result ${resultId}`);
}

function group(result: ComparisonVerifiedResult, evaluatorId: EvaluatorId): ComparisonEvaluationGroup {
  const found = result.evaluations.find((candidate) => candidate.evaluator_id === evaluatorId);
  if (!found) throw new Error(`no ${evaluatorId} group`);
  return found;
}

/** Every Result id in every container, in the order the containers hold them. */
function everyResultId(comparison: ComparisonRun): string[] {
  return [
    ...comparison.tools.flatMap((toolGroup) => toolGroup.results.map((r) => r.result_id)),
    ...comparison.legacy_unsealed_results.map((r) => r.result_id),
    ...comparison.unattributed_results.map((r) => r.result_id),
  ];
}

/** Every Evaluation id in every container. Headlines are references, not placements. */
function everyEvaluationId(comparison: ComparisonRun): string[] {
  const ids: string[] = [];
  for (const toolGroup of comparison.tools) {
    for (const result of toolGroup.results) {
      if (result.kind === 'verified') {
        for (const evaluatorGroup of result.evaluations) {
          ids.push(...evaluatorGroup.entries.map((e) => e.evaluation_id));
        }
      } else {
        ids.push(...result.verified_evaluations.map((e) => e.evaluation_id));
      }
      ids.push(...result.unclassified_rejected_evaluations.map((e) => e.evaluation_id));
    }
  }
  for (const result of comparison.legacy_unsealed_results) {
    ids.push(...result.verified_evaluations.map((e) => e.evaluation_id));
    ids.push(...result.unclassified_rejected_evaluations.map((e) => e.evaluation_id));
  }
  for (const result of comparison.unattributed_results) {
    ids.push(...result.related_verified_evaluations.map((e) => e.evaluation_id));
    ids.push(...result.related_rejected_evaluations.map((e) => e.evaluation_id));
  }
  ids.push(...comparison.unattributed_rejected_evaluations.map((e) => e.evaluation_id));
  ids.push(...comparison.unattributed_verified_evaluations.map((e) => e.evaluation_id));
  return ids;
}

/** Nothing listed is dropped, and nothing is placed twice. */
async function expectEverythingPlacedOnce(comparison: ComparisonRun): Promise<void> {
  const results = await listResultsForRun(deps(), RUN_ID);
  const evaluations = await listEvaluationsForRun(deps(), RUN_ID);
  expect([...everyResultId(comparison)].sort()).toEqual(results.map((r) => r.resultId).sort());
  expect([...everyEvaluationId(comparison)].sort()).toEqual(
    evaluations.map((e) => e.evaluationId).sort(),
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildRunComparison — trusted tool grouping', () => {
  it('shows Windows and Aqua side by side, with same-tool Results as siblings', async () => {
    await saveSealed(R3, 'aqua-voice');
    await saveSealed(R2, 'windows-standard-voice-input', { toolVersion: '24H2' });
    await saveSealed(R1, 'windows-standard-voice-input', { toolVersion: '23H2' });

    const comparison = await build();

    expect(toolKeys(comparison)).toEqual(['windows-standard-voice-input', 'aqua-voice']);
    const windows = comparison.tools[0]!;
    expect(windows.results.map((r) => r.result_id)).toEqual([R1, R2]);
    // The version belongs to each Result; the group asserts none.
    expect(windows.results.map((r) => (r.kind === 'verified' ? r.tool.version : null))).toEqual([
      '23H2',
      '24H2',
    ]);
    expect(Object.keys(windows).sort()).toEqual(['results', 'tool']);
    expect(windows.tool).toEqual({ kind: 'built-in', id: 'windows-standard-voice-input' });
    await expectEverythingPlacedOnce(comparison);
  });

  it('keeps two custom `other` tools apart, keyed by their trusted names', async () => {
    await saveSealed(R1, 'other', { customToolName: 'Zeta STT', toolVersion: '1.0' });
    await saveSealed(R2, 'other', { customToolName: 'Alpha STT', toolVersion: '2.0' });
    await saveSealed(R3, 'other', { customToolName: 'Alpha STT', toolVersion: '2.1' });
    await saveSealed(R4, 'aqua-voice');

    const comparison = await build();

    // Built-ins first in STT_TOOL_IDS order, then custom tools by trusted name.
    expect(toolKeys(comparison)).toEqual(['aqua-voice', 'other:Alpha STT', 'other:Zeta STT']);
    const alpha = comparison.tools[1]!;
    expect(alpha.tool).toEqual({ kind: 'custom', id: 'other', trusted_name: 'Alpha STT' });
    expect(alpha.results.map((r) => r.result_id)).toEqual([R2, R3]);
    expect(alpha.results.map((r) => (r.kind === 'verified' ? r.tool.version : null))).toEqual([
      '2.0',
      '2.1',
    ]);
    expect(comparison.tools[2]!.results.map((r) => r.result_id)).toEqual([R1]);
  });

  it('keeps a legacy unsealed Result out of every tool group, with its tool as a claim', async () => {
    await saveLegacy(R1);
    await saveSealed(R2, 'windows-standard-voice-input');

    const comparison = await build();

    expect(comparison.tools[0]!.results.map((r) => r.result_id)).toEqual([R2]);
    expect(comparison.legacy_unsealed_results).toEqual([
      {
        kind: 'legacy-unsealed-verified',
        result_id: R1,
        claimed_tool_id: 'windows-standard-voice-input',
        claimed_tool_name: BUILT_IN_TOOL_NAMES['windows-standard-voice-input'],
        claimed_tool_version: null,
        tool_claim_is_unverified: true,
        transcript: TRANSCRIPT,
        verified_evaluations: [],
        unclassified_rejected_evaluations: [],
      },
    ]);
    expect(comparison.completeness.legacy_unsealed_results).toBe(1);
    expect(comparison.completeness.sealed_verified_results).toBe(1);
  });

  it('shows a rejected legacy Result with no tool claim at all', async () => {
    await saveLegacy(R1);
    await removeTranscript(R1);

    const comparison = await build();

    expect(comparison.tools).toEqual([]);
    const [legacy] = comparison.legacy_unsealed_results;
    expect(legacy).toMatchObject({
      kind: 'legacy-unsealed-rejected',
      result_id: R1,
      reason: 'RESULT_TRANSCRIPT_MISSING',
    });
    expect(legacy).not.toHaveProperty('claimed_tool_id');
    expect(legacy).not.toHaveProperty('claimed_tool_name');
    expect(legacy).not.toHaveProperty('transcript');
  });

  it('places a sealed rejected built-in Result in its tool group, with nothing reconstructed', async () => {
    await saveSealed(R1, 'aqua-voice', { toolVersion: '0.9' });
    await overwriteTranscript(R1);

    const comparison = await build();

    expect(toolKeys(comparison)).toEqual(['aqua-voice']);
    const [rejected] = comparison.tools[0]!.results;
    expect(rejected).toMatchObject({
      kind: 'rejected',
      result_id: R1,
      trusted_tool_id: 'aqua-voice',
      integrity_trust: 'sealed',
      reason: 'RESULT_TRANSCRIPT_HASH_MISMATCH',
    });
    // Only what the rejected listing entry itself carries.
    for (const untrusted of ['captured_at', 'capture', 'transcript', 'tool', 'transcript_sha256']) {
      expect(rejected).not.toHaveProperty(untrusted);
    }
    expect(comparison.completeness.sealed_rejected_results).toBe(1);
    expect(comparison.completeness.state).toBe('partial');
  });

  it('sends a sealed rejected `other` Result to unattributed: its name is its identity', async () => {
    await saveSealed(R1, 'other', { customToolName: 'Alpha STT' });
    await overwriteTranscript(R1);

    const comparison = await build();

    expect(comparison.tools).toEqual([]);
    expect(comparison.unattributed_results).toEqual([
      expect.objectContaining({
        result_id: R1,
        reason_class: 'custom-tool-identity-unavailable',
        reason: 'RESULT_TRANSCRIPT_HASH_MISMATCH',
        integrity_trust: 'sealed',
      }),
    ]);
  });

  it('sends a Result whose seal broke to unattributed, with the Evaluations naming it', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    // Windows → Aqua without re-sealing: the claim is readable, not provable.
    await patchResult(R1, (json) => {
      json.tool = { id: 'aqua-voice', name: BUILT_IN_TOOL_NAMES['aqua-voice'], version: null };
    });

    const comparison = await build();

    expect(comparison.tools).toEqual([]);
    const [unattributed] = comparison.unattributed_results;
    expect(unattributed).toMatchObject({
      result_id: R1,
      reason_class: 'no-seal',
      reason: 'RESULT_INTEGRITY_MISMATCH',
      integrity_trust: null,
    });
    // The Evaluation no longer verifies either, and is kept rather than dropped.
    expect(unattributed!.related_rejected_evaluations.map((e) => e.evaluation_id)).toEqual([E1]);
    expect(unattributed!.related_verified_evaluations).toEqual([]);
    await expectEverythingPlacedOnce(comparison);
  });

  it('classifies a Result whose tool contract failed as tool-identity-unverified', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await patchResult(R1, (json) => {
      (json.tool as Record<string, unknown>).id = 'whisper';
    });

    const comparison = await build();

    expect(comparison.unattributed_results).toEqual([
      expect.objectContaining({ result_id: R1, reason_class: 'tool-identity-unverified' }),
    ]);
  });
});

describe('buildRunComparison — evaluator groups', () => {
  it('gives every sealed Result all four groups in EVALUATOR_IDS order, missing included', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);

    const comparison = await build();
    const result = verifiedResult(comparison, R1);

    expect(comparison.evaluator_ids).toEqual([...EVALUATOR_IDS]);
    expect(result.evaluations.map((g) => g.evaluator_id)).toEqual([...EVALUATOR_IDS]);
    expect(group(result, 'raw-char-v1')).toMatchObject({
      schema_version: 1,
      selection_reason: 'only-verified-entry-v1',
      state: { availability: 'available', verified_count: 1, multiple_candidates: false },
    });
    expect(group(result, 'raw-char-v1').headline?.evaluation_id).toBe(E1);
    for (const missing of ['surface-normalized-char-v1', 'critical-info-v1', 'semantic-h3-v1'] as const) {
      expect(group(result, missing)).toMatchObject({
        entries: [],
        headline: null,
        selection_reason: null,
        state: {
          availability: 'missing',
          verified_count: 0,
          multiple_candidates: false,
          conflicting_evidence: false,
        },
      });
    }
    expect(result.completeness).toEqual({
      state: 'partial',
      evaluators_present: ['raw-char-v1'],
      evaluators_missing: ['surface-normalized-char-v1', 'critical-info-v1', 'semantic-h3-v1'],
      unclassified_rejected_count: 0,
    });
  });

  it('carries the four readings separately, with no combined score', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    await evaluate(R1, 'surface-normalized-char-v1', E2);
    await evaluate(R1, 'critical-info-v1', E3);
    await evaluate(R1, 'semantic-h3-v1', E4, fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]));

    const comparison = await build();
    const result = verifiedResult(comparison, R1);

    expect(result.completeness.state).toBe('complete');
    expect(comparison.completeness.state).toBe('complete');
    expect(group(result, 'raw-char-v1').headline?.summary).toMatchObject({
      kind: 'raw-char-v1',
      exact_match: false,
    });
    expect(group(result, 'surface-normalized-char-v1').headline?.summary).toMatchObject({
      kind: 'surface-normalized-char-v1',
    });
    expect(group(result, 'critical-info-v1').headline?.summary).toMatchObject({
      kind: 'critical-info-v1',
      exact_entity_multiset_match: true,
      missing_keys: [],
      extra_keys: [],
    });
    expect(group(result, 'semantic-h3-v1').headline?.summary).toMatchObject({
      kind: 'semantic-h3-v1',
      decision: 'changed',
      decision_by: 'full-run-unanimous-changed-v1',
    });
    // Nothing that aggregates, ranks or grades.
    const payload = JSON.stringify(comparison);
    for (const forbidden of ['"score"', '"rank"', '"winner"', '"overall"', '"passed"', '"pass"']) {
      expect(payload).not.toContain(forbidden);
    }
  });

  it('keeps every verified entry and heads with the newest by id, whatever the write order', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    // Written newest first: the order on disk must not decide anything.
    await evaluate(R1, 'raw-char-v1', E3);
    await evaluate(R1, 'raw-char-v1', E1);
    await evaluate(R1, 'raw-char-v1', E2);

    const raw = group(verifiedResult(await build(), R1), 'raw-char-v1');

    expect(raw.entries.map((e) => e.evaluation_id)).toEqual([E1, E2, E3]);
    expect(raw.headline?.evaluation_id).toBe(E3);
    expect(raw.selection_reason).toBe('newest-verified-by-id-v1');
    expect(raw.state).toEqual({
      availability: 'available',
      verified_count: 3,
      multiple_candidates: true,
      conflicting_evidence: false,
    });
  });

  it('files a rejected Evaluation under its Result as unclassified, never in a group', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'critical-info-v1', E1);
    await patchEvaluation(E1, (json) => {
      (json.metrics as Record<string, unknown>).preservation_rate = 0.5;
    });

    const result = verifiedResult(await build(), R1);

    // The file still says critical-info-v1. That claim is not an attribution.
    expect(group(result, 'critical-info-v1').state.availability).toBe('missing');
    for (const evaluatorGroup of result.evaluations) expect(evaluatorGroup.entries).toEqual([]);
    expect(result.unclassified_rejected_evaluations).toEqual([
      expect.objectContaining({
        status: 'rejected',
        evaluation_id: E1,
        evaluator_id: null,
        schema_version: null,
        created_at: null,
        named_result_id: R1,
        reason: 'EVALUATION_INTEGRITY_MISMATCH',
      }),
    ]);
    expect(result.completeness.unclassified_rejected_count).toBe(1);
  });

  it('sends a rejected Evaluation that names no Result to Run level', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    await patchEvaluation(E1, (json) => {
      delete json.result_id;
    });

    const comparison = await build();

    expect(verifiedResult(comparison, R1).unclassified_rejected_evaluations).toEqual([]);
    expect(comparison.unattributed_rejected_evaluations).toEqual([
      expect.objectContaining({ evaluation_id: E1, named_result_id: null, evaluator_id: null }),
    ]);
    expect(comparison.completeness.unattributed_rejected_evaluations).toBe(1);
    expect(comparison.completeness.results_with_no_verified_evaluations).toBe(1);
    await expectEverythingPlacedOnce(comparison);
  });

  it('sends a rejected Evaluation naming a Result this Run does not have to Run level', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    await patchEvaluation(E1, (json) => {
      json.result_id = R_ABSENT;
    });

    const comparison = await build();

    expect(comparison.unattributed_rejected_evaluations).toEqual([
      expect.objectContaining({ evaluation_id: E1, named_result_id: R_ABSENT }),
    ]);
    await expectEverythingPlacedOnce(comparison);
  });

  it('keeps a rejected Evaluation naming a legacy Result beside that Result', async () => {
    await saveLegacy(R1);
    await saveSealed(R2, 'windows-standard-voice-input');
    await evaluate(R2, 'raw-char-v1', E1);
    await patchEvaluation(E1, (json) => {
      json.result_id = R1;
    });

    const comparison = await build();

    const [legacy] = comparison.legacy_unsealed_results;
    expect(legacy!.unclassified_rejected_evaluations.map((e) => e.evaluation_id)).toEqual([E1]);
    await expectEverythingPlacedOnce(comparison);
  });

  it('keeps Evaluations naming a sealed rejected Result on that Result', async () => {
    await saveSealed(R1, 'aqua-voice');
    await evaluate(R1, 'raw-char-v1', E1);
    await overwriteTranscript(R1);

    const comparison = await build();

    const [rejected] = comparison.tools[0]!.results;
    expect(rejected!.kind).toBe('rejected');
    expect(rejected!.unclassified_rejected_evaluations.map((e) => e.evaluation_id)).toEqual([E1]);
    await expectEverythingPlacedOnce(comparison);
  });
});

describe('buildRunComparison — Semantic', () => {
  it('keeps a full-run-unanimous preserved outcome as REVIEW REQUIRED', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'semantic-h3-v1', E1, fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]));

    const semantic = group(verifiedResult(await build(), R1), 'semantic-h3-v1');
    const summary = semantic.headline?.summary as SemanticSummary;

    expect(summary).toMatchObject({
      kind: 'semantic-h3-v1',
      decision: 'review',
      decision_by: 'full-run-unanimous-preserved-requires-review-v1',
      execution: {
        status: 'completed',
        runs_recorded: 3,
        runs_parseable: 3,
        full_run_unanimous: true,
        preserved_votes: 3,
        changed_votes: 0,
      },
      model: {
        model_id: SEMANTIC_MODEL_ID,
        model_digest: SEMANTIC_MODEL_DIGEST,
        runtime_version: SEMANTIC_RUNTIME_VERSION,
        prompt_sha256: SEMANTIC_RUBRIC_V1_SHA256,
      },
    });
    expect(semanticVerdictLabel(summary)).toBe('REVIEW REQUIRED');
  });

  it('publishes no headline when two verified Semantic executions disagree', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'semantic-h3-v1', E1, fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]));
    await evaluate(R1, 'semantic-h3-v1', E2, fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]));

    const semantic = group(verifiedResult(await build(), R1), 'semantic-h3-v1');

    expect(semantic.headline).toBeNull();
    expect(semantic.selection_reason).toBe('conflict-no-headline-v1');
    expect(semantic.state).toEqual({
      availability: 'available',
      verified_count: 2,
      multiple_candidates: true,
      conflicting_evidence: true,
    });
    // Both executions stay, in id order, each with its own decision.
    expect(
      semantic.entries.map((e) => [e.evaluation_id, (e.summary as SemanticSummary).decision]),
    ).toEqual([
      [E1, 'changed'],
      [E2, 'review'],
    ]);
  });

  it('treats two review decisions reached by different rules as a conflict too', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'semantic-h3-v1', E1, fakeRunner([VERDICT_CHANGED, VERDICT_PRESERVED, VERDICT_CHANGED]));
    await evaluate(R1, 'semantic-h3-v1', E2, fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]));

    const semantic = group(verifiedResult(await build(), R1), 'semantic-h3-v1');

    expect(semantic.entries.map((e) => (e.summary as SemanticSummary).decision_by)).toEqual([
      'split-vote-v1',
      'full-run-unanimous-preserved-requires-review-v1',
    ]);
    expect(semantic.headline).toBeNull();
    expect(semantic.state.conflicting_evidence).toBe(true);
  });

  it('heads agreeing Semantic executions with the newest, flagged as a selection', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'semantic-h3-v1', E1, fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]));
    await evaluate(R1, 'semantic-h3-v1', E2, fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]));

    const semantic = group(verifiedResult(await build(), R1), 'semantic-h3-v1');

    expect(semantic.headline?.evaluation_id).toBe(E2);
    expect(semantic.selection_reason).toBe('newest-verified-by-id-v1');
    expect(semantic.state.conflicting_evidence).toBe(false);
    expect(semantic.state.multiple_candidates).toBe(true);
  });

  it('states the Critical-veto route: CHANGED with zero runs and no model', async () => {
    await saveSealed(R1, 'aqua-voice', { transcript: WRONG_VALUE_TRANSCRIPT });
    await evaluate(R1, 'semantic-h3-v1', E1, UNREACHABLE_RUNNER);

    const semantic = group(verifiedResult(await build(), R1), 'semantic-h3-v1');

    expect(semantic.headline?.summary).toEqual({
      kind: 'semantic-h3-v1',
      decision: 'changed',
      decision_by: 'critical-guard-veto-v1',
      critical_guard: { status: 'applied', applicable: true, mismatch: true },
      execution: {
        status: 'skipped_by_critical_veto',
        runs_recorded: 0,
        runs_parseable: 0,
        runs_exact_format: 0,
        full_run_unanimous: false,
        changed_votes: 0,
        preserved_votes: 0,
      },
      model: null,
    });
    // Zero runs is a route, not a gap: the group is available.
    expect(semantic.state.availability).toBe('available');
  });
});

describe('buildRunComparison — Fail Closed on the Run', () => {
  it('fails the whole comparison when the Run no longer matches its manifest', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    await writeFile(path.join(runsRoot, RUN_ID, 'source.txt'), '別の文章。');

    const failure = await build().catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(RunEvidenceError);
    expect((failure as RunEvidenceError).kind).toBe('RUN_HASH_MISMATCH');
  });

  it('fails for a Run that does not exist, and for an id that is not a Run id', async () => {
    for (const runId of [OTHER_RUN_ID, '../evil', 'not-a-run']) {
      const failure = await buildRunComparison(deps(), runId).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(RunEvidenceError);
      expect((failure as RunEvidenceError).kind).toBe('RUN_NOT_FOUND');
    }
  });

  it('never shows Results or Evaluations of another Run', async () => {
    await writeRun(OTHER_RUN_ID);
    await saveSealed(R1, 'windows-standard-voice-input');
    await saveSealed(R2, 'aqua-voice', { runId: OTHER_RUN_ID });
    await evaluate(R2, 'raw-char-v1', E1);

    const comparison = await build();

    expect(everyResultId(comparison)).toEqual([R1]);
    expect(everyEvaluationId(comparison)).toEqual([]);
  });
});

describe('buildRunComparison — reading only, and deterministically', () => {
  async function seedMixedRun(): Promise<void> {
    await saveSealed(R1, 'windows-standard-voice-input');
    await saveSealed(R2, 'aqua-voice');
    await saveSealed(R3, 'other', { customToolName: 'Alpha STT' });
    await saveLegacy(R4);
    await saveSealed(R5, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    await evaluate(R1, 'raw-char-v1', E2);
    await evaluate(R2, 'critical-info-v1', E3);
    await evaluate(R3, 'surface-normalized-char-v1', E4);
    await evaluate(R5, 'raw-char-v1', E5);
    await patchEvaluation(E3, (json) => {
      (json.metrics as Record<string, unknown>).matched = 99;
    });
    await patchEvaluation(E5, (json) => {
      delete json.result_id;
    });
    await overwriteTranscript(R3);
  }

  it('writes nothing to any storage root', async () => {
    await seedMixedRun();
    const roots = [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot];
    const before = await Promise.all(roots.map(snapshot));

    await build();
    await build();

    expect(await Promise.all(roots.map(snapshot))).toEqual(before);
  });

  it('places every listed Result and Evaluation exactly once', async () => {
    await seedMixedRun();
    const comparison = await build();

    await expectEverythingPlacedOnce(comparison);
    expect(new Set(everyEvaluationId(comparison)).size).toBe(everyEvaluationId(comparison).length);
    expect(comparison.completeness).toEqual({
      state: 'partial',
      sealed_verified_results: 3,
      sealed_rejected_results: 0,
      legacy_unsealed_results: 1,
      unattributed_results: 1,
      unattributed_rejected_evaluations: 1,
      unattributed_verified_evaluations: 0,
      results_with_no_verified_evaluations: 2,
    });
  });

  it('does not depend on the order the listings arrive in', async () => {
    await seedMixedRun();
    const runEvidence = await verifyRunEvidence(runStore, RUN_ID);
    const results = await listResultsForRun(deps(), RUN_ID);
    const evaluations = await listEvaluationsForRun(deps(), RUN_ID);

    const forward = assembleRunComparison({ runEvidence, results, evaluations });
    const reversed = assembleRunComparison({
      runEvidence,
      results: [...results].reverse(),
      evaluations: [...evaluations].reverse(),
    });

    expect(reversed).toEqual(forward);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it('keeps a verified Evaluation whose Result is missing from the listing, at Run level', async () => {
    await saveSealed(R1, 'windows-standard-voice-input');
    await evaluate(R1, 'raw-char-v1', E1);
    const runEvidence = await verifyRunEvidence(runStore, RUN_ID);
    const evaluations = await listEvaluationsForRun(deps(), RUN_ID);

    // The two listings disagreeing is not expected; if it ever happens, nothing
    // is guessed and nothing is dropped.
    const comparison = assembleRunComparison({ runEvidence, results: [], evaluations });

    expect(comparison.tools).toEqual([]);
    expect(comparison.unattributed_verified_evaluations.map((e) => e.evaluation_id)).toEqual([E1]);
    expect(comparison.completeness.state).toBe('partial');
  });

  it('builds a valid, empty comparison for a Run with no Results', async () => {
    const comparison = await build();

    expect(comparison).toMatchObject({
      run_id: RUN_ID,
      test_id: 'numbers-units-001',
      evidence: {
        manifest_schema_version: 2,
        source_sha256: sha(SOURCE_TEXT),
        audio_sha256: sha(AUDIO),
        generated_at: NOW.toISOString(),
        segment_count: 1,
      },
      tools: [],
      legacy_unsealed_results: [],
      unattributed_results: [],
      unattributed_rejected_evaluations: [],
      unattributed_verified_evaluations: [],
    });
    expect(comparison.completeness.state).toBe('partial');
    expect(comparison.completeness.sealed_verified_results).toBe(0);
  });
});
