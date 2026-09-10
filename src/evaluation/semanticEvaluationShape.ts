import { EvaluationVerificationError } from './verifyStoredEvaluation';

/**
 * Structural validation of a stored Semantic Evaluation, before anything reads it.
 *
 * The canonicalizer walks the whole artifact by hand — `critical.entities.reference.map(...)`,
 * `execution.runs.map(...)`, and so on — because writing every property out is what
 * makes the seal independent of key order and indentation. That same explicitness
 * means it dereferences whatever the file happens to contain, so a malformed
 * `evaluation.json` reached it as a raw `TypeError` and surfaced as `UNEXPECTED`.
 * "Cannot read properties of undefined" is not a verification verdict; it tells a
 * reader nothing about which artifact is wrong or how.
 *
 * So the shape is checked first, and every failure is an ordinary
 * `EVALUATION_MALFORMED` naming the exact path.
 *
 * The check is **closed**. Every object listed here rejects a field this build
 * does not know, and that is the point rather than strictness for its own sake:
 * the canonicalizer only hashes the fields it names, so an extra one costs the
 * seal nothing and would otherwise ride along inside an artifact that reads back
 * as `verified`. A field nobody hashes is a field nobody is holding to anything.
 *
 * Only shape and type are decided here. What the values *mean* — whether the
 * evaluator is the approved contract, whether the decision re-derives, whether a
 * response matches its hash — stays with the checks that own those questions, so
 * each one keeps reporting its own error kind.
 */

type Rec = Record<string, unknown>;

const ENTITY_FIELDS = [
  'kind',
  'raw',
  'start_code_point',
  'end_code_point',
  'canonical_key',
] as const;

const MATCH_FIELDS = ['canonical_key', 'reference', 'hypothesis'] as const;

const METRICS_FIELDS = [
  'reference_entities',
  'hypothesis_entities',
  'matched',
  'missing',
  'extra',
  'preservation_rate',
  'exact_entity_multiset_match',
] as const;

const VERDICT_FIELDS = [
  'meaning_preserved',
  'severity',
  'negation',
  'direction_location',
  'instruction_action',
  'critical_fact',
  'domain_term',
  'reason_codes',
  'short_rationale',
] as const;

const RUN_FIELDS = [
  'run_index',
  'latency_ms',
  'request_sha256',
  'raw_response',
  'raw_response_sha256',
  'raw_response_chars',
  'parseable_schema_valid',
  'exact_output_contract_valid',
  'parsed_output',
  'error',
] as const;

const ROOT_FIELDS = [
  'schema_version',
  'evaluation_id',
  'created_at',
  'evaluator',
  'run_id',
  'result_id',
  'subject',
  'reference',
  'hypothesis',
  'run_evidence',
  'normalized',
  'critical',
  'execution',
  'decision',
  'integrity',
] as const;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check the whole nested shape, or throw EVALUATION_MALFORMED naming the path.
 *
 * `evaluator` is deliberately only required to be an object here. Its field list
 * and its values are the evaluator contract's own question, and answering it in
 * this function would turn a tampered contract into a malformed file.
 */
export function assertSemanticEvaluationShape(evaluationId: string, stored: Rec): void {
  const bad = (path: string, expected: string, actual: unknown): never => {
    throw new EvaluationVerificationError(
      'EVALUATION_MALFORMED',
      evaluationId,
      `evaluation.json の ${path} が ${expected} ではありません。`,
      `path=${path} actual=${JSON.stringify(actual) ?? String(actual)}`,
    );
  };

  const closed = (value: unknown, path: string, allowed: readonly string[]): Rec => {
    if (!isRec(value)) return bad(path, 'オブジェクト', value);
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        throw new EvaluationVerificationError(
          'EVALUATION_MALFORMED',
          evaluationId,
          `evaluation.json の ${path} に未知の field があります: ${key}`,
          `path=${path}.${key} allowed=${allowed.join(' / ')}`,
        );
      }
    }
    for (const key of allowed) {
      if (!(key in value)) bad(`${path}.${key}`, '存在する field', undefined);
    }
    return value;
  };

  const str = (value: unknown, path: string): void => {
    if (typeof value !== 'string') bad(path, '文字列', value);
  };
  const num = (value: unknown, path: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) bad(path, '有限の数値', value);
  };
  const bool = (value: unknown, path: string): void => {
    if (typeof value !== 'boolean') bad(path, '真偽値', value);
  };
  const strOrNull = (value: unknown, path: string): void => {
    if (value !== null && typeof value !== 'string') bad(path, '文字列または null', value);
  };

  const entity = (value: unknown, path: string): void => {
    const e = closed(value, path, ENTITY_FIELDS);
    str(e.kind, `${path}.kind`);
    str(e.raw, `${path}.raw`);
    num(e.start_code_point, `${path}.start_code_point`);
    num(e.end_code_point, `${path}.end_code_point`);
    str(e.canonical_key, `${path}.canonical_key`);
  };

  const entityList = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) bad(path, '配列', value);
    (value as unknown[]).forEach((item, i) => entity(item, `${path}[${i}]`));
  };

  const entityListOrNull = (value: unknown, path: string): void => {
    if (value === null) return;
    entityList(value, path);
  };

  closed(stored, 'root', ROOT_FIELDS);

  num(stored.schema_version, 'schema_version');
  str(stored.evaluation_id, 'evaluation_id');
  str(stored.created_at, 'created_at');
  str(stored.run_id, 'run_id');
  str(stored.result_id, 'result_id');
  if (!isRec(stored.evaluator)) bad('evaluator', 'オブジェクト', stored.evaluator);

  // --- subject ------------------------------------------------------------
  const subject = closed(stored.subject, 'subject', [
    'result_schema_version',
    'tool',
    'capture',
    'result_semantic_sha256',
  ]);
  num(subject.result_schema_version, 'subject.result_schema_version');
  str(subject.result_semantic_sha256, 'subject.result_semantic_sha256');
  const tool = closed(subject.tool, 'subject.tool', ['id', 'name', 'version']);
  str(tool.id, 'subject.tool.id');
  str(tool.name, 'subject.tool.name');
  strOrNull(tool.version, 'subject.tool.version');
  const capture = closed(subject.capture, 'subject.capture', ['method', 'delivery_path']);
  str(capture.method, 'subject.capture.method');
  str(capture.delivery_path, 'subject.capture.delivery_path');

  // --- the raw inputs -----------------------------------------------------
  for (const side of ['reference', 'hypothesis'] as const) {
    const s = closed(stored[side], side, ['file', 'sha256', 'chars']);
    str(s.file, `${side}.file`);
    str(s.sha256, `${side}.sha256`);
    num(s.chars, `${side}.chars`);
  }

  const evidence = closed(stored.run_evidence, 'run_evidence', [
    'manifest_schema_version',
    'test_id',
    'source_sha256',
    'audio_sha256',
  ]);
  num(evidence.manifest_schema_version, 'run_evidence.manifest_schema_version');
  str(evidence.test_id, 'run_evidence.test_id');
  str(evidence.source_sha256, 'run_evidence.source_sha256');
  str(evidence.audio_sha256, 'run_evidence.audio_sha256');

  // --- what the model was shown -------------------------------------------
  const normalized = closed(stored.normalized, 'normalized', ['reference', 'hypothesis']);
  for (const side of ['reference', 'hypothesis'] as const) {
    const s = closed(normalized[side], `normalized.${side}`, ['sha256', 'chars']);
    str(s.sha256, `normalized.${side}.sha256`);
    num(s.chars, `normalized.${side}.chars`);
  }

  // --- the guard's working ------------------------------------------------
  const critical = closed(stored.critical, 'critical', [
    'status',
    'applicable',
    'mismatch',
    'entities',
    'matches',
    'missing',
    'extra',
    'metrics',
    'unavailable_reason',
  ]);
  str(critical.status, 'critical.status');
  bool(critical.applicable, 'critical.applicable');
  bool(critical.mismatch, 'critical.mismatch');
  strOrNull(critical.unavailable_reason, 'critical.unavailable_reason');

  if (critical.entities !== null) {
    const entities = closed(critical.entities, 'critical.entities', ['reference', 'hypothesis']);
    entityList(entities.reference, 'critical.entities.reference');
    entityList(entities.hypothesis, 'critical.entities.hypothesis');
  }
  if (critical.matches !== null) {
    if (!Array.isArray(critical.matches)) {
      bad('critical.matches', '配列または null', critical.matches);
    }
    (critical.matches as unknown[]).forEach((item, i) => {
      const path = `critical.matches[${i}]`;
      const m = closed(item, path, MATCH_FIELDS);
      str(m.canonical_key, `${path}.canonical_key`);
      entity(m.reference, `${path}.reference`);
      entity(m.hypothesis, `${path}.hypothesis`);
    });
  }
  entityListOrNull(critical.missing, 'critical.missing');
  entityListOrNull(critical.extra, 'critical.extra');
  if (critical.metrics !== null) {
    const metrics = closed(critical.metrics, 'critical.metrics', METRICS_FIELDS);
    num(metrics.reference_entities, 'critical.metrics.reference_entities');
    num(metrics.hypothesis_entities, 'critical.metrics.hypothesis_entities');
    num(metrics.matched, 'critical.metrics.matched');
    num(metrics.missing, 'critical.metrics.missing');
    num(metrics.extra, 'critical.metrics.extra');
    num(metrics.preservation_rate, 'critical.metrics.preservation_rate');
    bool(metrics.exact_entity_multiset_match, 'critical.metrics.exact_entity_multiset_match');
  }

  // --- the execution record -----------------------------------------------
  const execution = closed(stored.execution, 'execution', [
    'status',
    'endpoint_class',
    'provider_protocol',
    'runtime',
    'model',
    'prompt',
    'request_contract',
    'runs',
  ]);
  str(execution.status, 'execution.status');
  strOrNull(execution.endpoint_class, 'execution.endpoint_class');
  strOrNull(execution.provider_protocol, 'execution.provider_protocol');

  if (execution.runtime !== null) {
    const runtime = closed(execution.runtime, 'execution.runtime', ['name', 'version']);
    str(runtime.name, 'execution.runtime.name');
    str(runtime.version, 'execution.runtime.version');
  }
  if (execution.model !== null) {
    const model = closed(execution.model, 'execution.model', ['id', 'digest', 'quantization']);
    str(model.id, 'execution.model.id');
    str(model.digest, 'execution.model.digest');
    str(model.quantization, 'execution.model.quantization');
  }
  if (execution.prompt !== null) {
    const prompt = closed(execution.prompt, 'execution.prompt', ['id', 'sha256']);
    str(prompt.id, 'execution.prompt.id');
    str(prompt.sha256, 'execution.prompt.sha256');
  }
  if (execution.request_contract !== null) {
    const contract = closed(execution.request_contract, 'execution.request_contract', [
      'repeats',
      'temperature',
      'num_predict',
      'top_p',
      'seed',
      'stream',
    ]);
    num(contract.repeats, 'execution.request_contract.repeats');
    num(contract.temperature, 'execution.request_contract.temperature');
    num(contract.num_predict, 'execution.request_contract.num_predict');
    str(contract.top_p, 'execution.request_contract.top_p');
    str(contract.seed, 'execution.request_contract.seed');
    bool(contract.stream, 'execution.request_contract.stream');
  }

  if (!Array.isArray(execution.runs)) bad('execution.runs', '配列', execution.runs);
  (execution.runs as unknown[]).forEach((item, i) => {
    const path = `execution.runs[${i}]`;
    const run = closed(item, path, RUN_FIELDS);
    num(run.run_index, `${path}.run_index`);
    num(run.latency_ms, `${path}.latency_ms`);
    str(run.request_sha256, `${path}.request_sha256`);
    str(run.raw_response, `${path}.raw_response`);
    str(run.raw_response_sha256, `${path}.raw_response_sha256`);
    num(run.raw_response_chars, `${path}.raw_response_chars`);
    bool(run.parseable_schema_valid, `${path}.parseable_schema_valid`);
    bool(run.exact_output_contract_valid, `${path}.exact_output_contract_valid`);
    strOrNull(run.error, `${path}.error`);

    if (run.parsed_output !== null) {
      const verdict = closed(run.parsed_output, `${path}.parsed_output`, VERDICT_FIELDS);
      bool(verdict.meaning_preserved, `${path}.parsed_output.meaning_preserved`);
      str(verdict.severity, `${path}.parsed_output.severity`);
      bool(verdict.negation, `${path}.parsed_output.negation`);
      bool(verdict.direction_location, `${path}.parsed_output.direction_location`);
      bool(verdict.instruction_action, `${path}.parsed_output.instruction_action`);
      bool(verdict.critical_fact, `${path}.parsed_output.critical_fact`);
      bool(verdict.domain_term, `${path}.parsed_output.domain_term`);
      str(verdict.short_rationale, `${path}.parsed_output.short_rationale`);
      const codes = verdict.reason_codes;
      if (!Array.isArray(codes) || !codes.every((code) => typeof code === 'string')) {
        bad(`${path}.parsed_output.reason_codes`, '文字列の配列', codes);
      }
    }
  });

  // --- the decision -------------------------------------------------------
  // `value` and `by` are only required to be strings. Whether they are the
  // decision H3 re-derives is EVALUATION_DECISION_MISMATCH's question.
  const decision = closed(stored.decision, 'decision', ['value', 'by']);
  str(decision.value, 'decision.value');
  str(decision.by, 'decision.by');

  // --- the seal record ----------------------------------------------------
  // Presence and type only; EVALUATION_INTEGRITY_MISSING owns the rest.
  if (!isRec(stored.integrity)) bad('integrity', 'オブジェクト', stored.integrity);
}
