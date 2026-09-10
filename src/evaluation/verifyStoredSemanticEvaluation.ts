import { sha256OfText } from '@/lib/hash';
import { isValidEvaluationId } from '@/lib/evaluationId';
import { computeResultSemanticSha256, resultPayloadOf } from '@/results/resultSchema';
import { toCodePoints } from './rawChar';
import type { EvaluationSubject } from './evaluationSubject';
import {
  EvaluationVerificationError,
  type EvaluationVerificationErrorKind,
} from './verifyStoredEvaluation';
import {
  SEMANTIC_EVALUATION_SCHEMA_VERSION,
  SEMANTIC_H3_EVALUATOR,
  SEMANTIC_REQUEST_CONTRACT,
  computeSemanticEvaluationSemanticSha256,
  isSemanticH3Evaluator,
  type SemanticEvaluationPayloadV4,
  type SemanticEvaluationV4,
  type SemanticRunV4,
} from './semanticEvaluationSchema';
import {
  SEMANTIC_MODEL_DIGEST,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_QUANTIZATION,
  SEMANTIC_PROVIDER_PROTOCOL,
  SEMANTIC_RUNTIME_NAME,
  SEMANTIC_RUNTIME_VERSION,
} from './semanticProvider';
import { SEMANTIC_RUBRIC_V1_ID, SEMANTIC_RUBRIC_V1_SHA256 } from './semanticPrompt';
import { parseSemanticVerdict, semanticRequestSha256 } from './semanticRubric';
import {
  deriveSemanticDecision,
  isSemanticDecisionValue,
  tallySemanticRuns,
} from './semanticDecision';
import { normalizeSemanticInput, runSemanticCriticalGuard } from './semanticGuard';
import { assertSemanticEvaluationShape } from './semanticEvaluationShape';

/**
 * Verification of a Semantic Evaluation read back from disk.
 *
 * The model is never called again. That is not a shortcut — it is the point.
 * A local model asked the same question twice may answer differently, so
 * "re-run it and compare" would fail honest artifacts and pass nothing useful.
 *
 * What is checked instead is everything except the model's opinion:
 *
 *   1. the seal, over the whole artifact;
 *   2. the subject — Run and sealed Result v2 evidence, re-read from disk;
 *   3. the raw input hashes, and the normalization that produced what was sent;
 *   4. the critical guard, recomputed from the actual bytes;
 *   5. the runtime, model, prompt and request contract, against the pinned ones;
 *   6. every stored response against its own hash, then re-parsed;
 *   7. the vote and the H3 decision, re-derived and compared.
 *
 * So the claim a verified v4 artifact supports is: *this text came back from
 * this model under this contract, and everything downstream of it follows
 * deterministically*. Not: *the model would say this again*.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function verifyStoredSemanticEvaluation(input: {
  evaluationId: string;
  stored: unknown;
  subject: EvaluationSubject;
}): SemanticEvaluationV4 {
  const { evaluationId, stored, subject } = input;
  const fail = (
    kind: EvaluationVerificationErrorKind,
    message: string,
    detail?: string,
  ): never => {
    throw new EvaluationVerificationError(kind, evaluationId, message, detail);
  };

  if (!isValidEvaluationId(evaluationId)) {
    fail('EVALUATION_ID_MISMATCH', `evaluation id の形式が不正です: ${JSON.stringify(evaluationId)}`);
  }
  if (!isPlainObject(stored)) {
    fail('EVALUATION_MALFORMED', 'evaluation.json がオブジェクトではありません。');
  }

  const raw = stored as Record<string, unknown>;

  if (raw.schema_version !== SEMANTIC_EVALUATION_SCHEMA_VERSION) {
    fail(
      'EVALUATION_SCHEMA_UNSUPPORTED',
      `Evaluation schema v${String(raw.schema_version)} は semantic-h3-v1 の対象外です。`,
      `schema_version=${String(raw.schema_version)}`,
    );
  }

  if (raw.evaluation_id !== evaluationId) {
    fail(
      'EVALUATION_ID_MISMATCH',
      'evaluation.json の evaluation_id が保存先ディレクトリと一致しません。',
      `directory=${evaluationId} evaluation_id=${String(raw.evaluation_id)}`,
    );
  }

  if (typeof raw.created_at !== 'string' || Number.isNaN(Date.parse(raw.created_at))) {
    fail('EVALUATION_MALFORMED', 'created_at が有効な timestamp ではありません。');
  }

  // The evaluator has to be there before the seal can be computed over it. Its
  // values are checked after the seal, so a tampered file reads as tampered.
  if (!isPlainObject(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が記録として読めません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(SEMANTIC_H3_EVALUATOR)}`,
    );
  }

  // Everything the canonicalizer is about to walk, checked first and closed.
  // Sealing a malformed artifact would dereference whatever the file contains
  // and surface a TypeError as UNEXPECTED; an unknown field would sail through
  // unhashed inside something that still read back as verified.
  assertSemanticEvaluationShape(evaluationId, raw);

  const normalizedSection = raw.normalized as Record<string, unknown>;
  const executionSection = raw.execution as Record<string, unknown>;

  // --- The seal -----------------------------------------------------------
  const integrity = raw.integrity;
  if (
    !isPlainObject(integrity) ||
    integrity.algorithm !== 'sha256' ||
    typeof integrity.semantic_sha256 !== 'string' ||
    !SHA256_PATTERN.test(integrity.semantic_sha256)
  ) {
    fail('EVALUATION_INTEGRITY_MISSING', 'integrity が sha256 の記録として読めません。');
  }

  const recordedSeal = (integrity as Record<string, unknown>).semantic_sha256 as string;
  const actualSeal = computeSemanticEvaluationSemanticSha256(
    raw as unknown as SemanticEvaluationPayloadV4,
  );
  if (recordedSeal !== actualSeal) {
    fail(
      'EVALUATION_INTEGRITY_MISMATCH',
      'Evaluation の metadata が記録された semantic hash と一致しません。保存後に編集された可能性があります。',
      `recorded=${recordedSeal} actual=${actualSeal}`,
    );
  }

  // --- The evaluator ------------------------------------------------------
  if (!isSemanticH3Evaluator(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が semantic-h3-v1 の contract 8 field と一致しません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(SEMANTIC_H3_EVALUATOR)}`,
    );
  }

  // --- The subject --------------------------------------------------------
  const subjectSection = raw.subject as Record<string, unknown>;
  const referenceSection = raw.reference as Record<string, unknown>;
  const hypothesisSection = raw.hypothesis as Record<string, unknown>;
  const evidenceSection = raw.run_evidence as Record<string, unknown>;

  const resultSeal = computeResultSemanticSha256(resultPayloadOf(subject.result));

  const subjectChecks: Array<[string, unknown, unknown]> = [
    ['run_id', raw.run_id, subject.runId],
    ['result_id', raw.result_id, subject.resultId],
    ['subject.result_schema_version', subjectSection.result_schema_version, 2],
    ['subject.result_semantic_sha256', subjectSection.result_semantic_sha256, resultSeal],
    ['reference.file', referenceSection.file, 'run/source.txt'],
    ['reference.sha256', referenceSection.sha256, sha256OfText(subject.referenceText)],
    ['reference.chars', referenceSection.chars, toCodePoints(subject.referenceText).length],
    ['hypothesis.file', hypothesisSection.file, 'result/transcript.txt'],
    ['hypothesis.sha256', hypothesisSection.sha256, sha256OfText(subject.hypothesisText)],
    ['hypothesis.chars', hypothesisSection.chars, toCodePoints(subject.hypothesisText).length],
    [
      'run_evidence.manifest_schema_version',
      evidenceSection.manifest_schema_version,
      subject.runEvidence.manifestSchemaVersion,
    ],
    ['run_evidence.test_id', evidenceSection.test_id, subject.runEvidence.testId],
    ['run_evidence.source_sha256', evidenceSection.source_sha256, subject.runEvidence.sourceSha256],
    ['run_evidence.audio_sha256', evidenceSection.audio_sha256, subject.runEvidence.audioSha256],
  ];
  for (const [field, recorded, current] of subjectChecks) {
    if (recorded !== current) {
      fail(
        'EVALUATION_SUBJECT_MISMATCH',
        `${field} が現在の Run / Result と一致しません。`,
        `recorded=${String(recorded)} current=${String(current)}`,
      );
    }
  }

  const tool = subjectSection.tool;
  if (
    !isPlainObject(tool) ||
    tool.id !== subject.result.tool.id ||
    tool.name !== subject.result.tool.name ||
    tool.version !== subject.result.tool.version
  ) {
    fail(
      'EVALUATION_SUBJECT_MISMATCH',
      'subject.tool が Result の tool と一致しません。',
      `recorded=${JSON.stringify(tool)} current=${JSON.stringify(subject.result.tool)}`,
    );
  }

  const capture = subjectSection.capture;
  if (
    !isPlainObject(capture) ||
    capture.method !== subject.result.capture.method ||
    capture.delivery_path !== subject.result.capture.delivery_path
  ) {
    fail(
      'EVALUATION_SUBJECT_MISMATCH',
      'subject.capture が Result の capture と一致しません。',
      `recorded=${JSON.stringify(capture)} current=${JSON.stringify(subject.result.capture)}`,
    );
  }

  // --- The normalization --------------------------------------------------
  // These are the exact texts the guard read and the model was shown, so they
  // are re-derived from the bytes before anything downstream is believed.
  const normalizedReference = normalizeSemanticInput(subject.referenceText);
  const normalizedHypothesis = normalizeSemanticInput(subject.hypothesisText);
  const referenceSide = normalizedSection.reference as Record<string, unknown>;
  const hypothesisSide = normalizedSection.hypothesis as Record<string, unknown>;

  const normalizationChecks: Array<[string, unknown, unknown]> = [
    ['normalized.reference.sha256', referenceSide.sha256, normalizedReference.side.sha256],
    ['normalized.reference.chars', referenceSide.chars, normalizedReference.side.chars],
    ['normalized.hypothesis.sha256', hypothesisSide.sha256, normalizedHypothesis.side.sha256],
    ['normalized.hypothesis.chars', hypothesisSide.chars, normalizedHypothesis.side.chars],
  ];
  for (const [field, recorded, current] of normalizationChecks) {
    if (recorded !== current) {
      fail(
        'EVALUATION_NORMALIZATION_MISMATCH',
        `${field} を再計算すると記録と一致しません。`,
        `recorded=${String(recorded)} recomputed=${String(current)}`,
      );
    }
  }

  // --- The critical guard -------------------------------------------------
  // Recomputed from the actual Run/Result bytes, not read back from the record.
  // A veto is the one path that decides on its own, so it has to stay auditable.
  // Raw, matching the adopted composition: the guard never read the normalized
  // pair, so recomputing it from those bytes would check a different evaluator.
  const guard = runSemanticCriticalGuard(subject.referenceText, subject.hypothesisText);
  const criticalSection = raw.critical as Record<string, unknown>;
  const guardChecks: Array<[string, unknown, unknown]> = [
    ['critical.status', criticalSection.status, guard.status],
    ['critical.applicable', criticalSection.applicable, guard.applicable],
    ['critical.mismatch', criticalSection.mismatch, guard.mismatch],
    ['critical.unavailable_reason', criticalSection.unavailable_reason, guard.unavailable_reason],
  ];
  for (const [field, recorded, current] of guardChecks) {
    if (recorded !== current) {
      fail(
        'EVALUATION_CRITICAL_GUARD_MISMATCH',
        `${field} を再計算すると記録と一致しません。`,
        `recorded=${String(recorded)} recomputed=${String(current)}`,
      );
    }
  }

  const guardEvidenceChecks: Array<[string, unknown, unknown]> = [
    ['critical.entities', criticalSection.entities, guard.entities],
    ['critical.matches', criticalSection.matches, guard.matches],
    ['critical.missing', criticalSection.missing, guard.missing],
    ['critical.extra', criticalSection.extra, guard.extra],
    ['critical.metrics', criticalSection.metrics, guard.metrics],
  ];
  for (const [field, recorded, current] of guardEvidenceChecks) {
    if (JSON.stringify(recorded) !== JSON.stringify(current)) {
      fail(
        'EVALUATION_CRITICAL_GUARD_MISMATCH',
        `${field} を再計算すると記録と一致しません。`,
        `recorded=${JSON.stringify(recorded)} recomputed=${JSON.stringify(current)}`,
      );
    }
  }

  // --- The execution contract ---------------------------------------------
  const runs = executionSection.runs as unknown[];
  const veto = guard.mismatch;

  if (veto) {
    // Nothing was contacted. The absence has to be complete, or the record is
    // claiming a model call it never made.
    const skippedChecks: Array<[string, unknown, unknown]> = [
      ['execution.status', executionSection.status, 'skipped_by_critical_veto'],
      ['execution.endpoint_class', executionSection.endpoint_class, null],
      ['execution.provider_protocol', executionSection.provider_protocol, null],
      ['execution.runtime', executionSection.runtime, null],
      ['execution.model', executionSection.model, null],
      ['execution.prompt', executionSection.prompt, null],
      ['execution.request_contract', executionSection.request_contract, null],
    ];
    for (const [field, recorded, current] of skippedChecks) {
      if (recorded !== current) {
        fail(
          'EVALUATION_EXECUTION_MISMATCH',
          `${field} が Critical veto の記録と一致しません。`,
          `recorded=${JSON.stringify(recorded)} expected=${JSON.stringify(current)}`,
        );
      }
    }
    if (runs.length !== 0) {
      fail(
        'EVALUATION_EXECUTION_MISMATCH',
        'Critical veto が成立した Evaluation に model run が記録されています。',
        `runs=${runs.length}`,
      );
    }
  } else {
    if (executionSection.status !== 'completed') {
      fail(
        'EVALUATION_EXECUTION_MISMATCH',
        'execution.status が completed ではありません。',
        `recorded=${String(executionSection.status)}`,
      );
    }
    if (
      executionSection.endpoint_class !== 'loopback' ||
      executionSection.provider_protocol !== SEMANTIC_PROVIDER_PROTOCOL
    ) {
      fail(
        'EVALUATION_EXECUTION_MISMATCH',
        'execution の transport 記録が loopback / Ollama native ではありません。',
        `endpoint_class=${String(executionSection.endpoint_class)} protocol=${String(executionSection.provider_protocol)}`,
      );
    }

    const runtime = executionSection.runtime;
    if (
      !isPlainObject(runtime) ||
      runtime.name !== SEMANTIC_RUNTIME_NAME ||
      runtime.version !== SEMANTIC_RUNTIME_VERSION
    ) {
      fail(
        'EVALUATION_MODEL_CONTRACT_MISMATCH',
        `runtime が ${SEMANTIC_RUNTIME_NAME} ${SEMANTIC_RUNTIME_VERSION} と一致しません。`,
        `recorded=${JSON.stringify(runtime)}`,
      );
    }

    const model = executionSection.model;
    if (
      !isPlainObject(model) ||
      model.id !== SEMANTIC_MODEL_ID ||
      model.digest !== SEMANTIC_MODEL_DIGEST ||
      model.quantization !== SEMANTIC_MODEL_QUANTIZATION
    ) {
      fail(
        'EVALUATION_MODEL_CONTRACT_MISMATCH',
        'model が承認された id / digest / quantization と一致しません。',
        `recorded=${JSON.stringify(model)}`,
      );
    }

    const prompt = executionSection.prompt;
    if (
      !isPlainObject(prompt) ||
      prompt.id !== SEMANTIC_RUBRIC_V1_ID ||
      prompt.sha256 !== SEMANTIC_RUBRIC_V1_SHA256
    ) {
      fail(
        'EVALUATION_PROMPT_MISMATCH',
        'prompt が承認された semantic-rubric-v1 と一致しません。',
        `recorded=${JSON.stringify(prompt)}`,
      );
    }

    const contract = executionSection.request_contract;
    if (JSON.stringify(contract) !== JSON.stringify(SEMANTIC_REQUEST_CONTRACT)) {
      fail(
        'EVALUATION_MODEL_CONTRACT_MISMATCH',
        'request_contract が承認された値と一致しません。',
        `recorded=${JSON.stringify(contract)} expected=${JSON.stringify(SEMANTIC_REQUEST_CONTRACT)}`,
      );
    }
  }

  // --- The stored responses -----------------------------------------------
  // Raw response → hash → parser → parsed output. Every step is redone, so a
  // parsed verdict that never came from the text next to it is caught even
  // when the artifact was resealed after the edit.
  const expectedRequestSha = semanticRequestSha256(
    normalizedReference.text,
    normalizedHypothesis.text,
  );

  const rederivedRuns: SemanticRunV4[] = [];
  runs.forEach((entry, index) => {
    const label = `execution.runs[${index}]`;
    if (!isPlainObject(entry)) {
      fail('EVALUATION_MALFORMED', `${label} がオブジェクトではありません。`);
    }
    const run = entry as Record<string, unknown>;

    if (run.run_index !== index + 1) {
      fail(
        'EVALUATION_RESPONSE_MISMATCH',
        `${label}.run_index が並び順と一致しません。`,
        `recorded=${String(run.run_index)} expected=${index + 1}`,
      );
    }
    if (typeof run.raw_response !== 'string') {
      fail('EVALUATION_MALFORMED', `${label}.raw_response が文字列ではありません。`);
    }
    const rawResponse = run.raw_response as string;

    if (run.request_sha256 !== expectedRequestSha) {
      fail(
        'EVALUATION_RESPONSE_MISMATCH',
        `${label}.request_sha256 を再構築すると記録と一致しません。`,
        `recorded=${String(run.request_sha256)} recomputed=${expectedRequestSha}`,
      );
    }
    if (run.raw_response_sha256 !== sha256OfText(rawResponse)) {
      fail(
        'EVALUATION_RESPONSE_MISMATCH',
        `${label}.raw_response_sha256 が raw_response と一致しません。`,
        `recorded=${String(run.raw_response_sha256)} recomputed=${sha256OfText(rawResponse)}`,
      );
    }
    if (run.raw_response_chars !== toCodePoints(rawResponse).length) {
      fail(
        'EVALUATION_RESPONSE_MISMATCH',
        `${label}.raw_response_chars が raw_response と一致しません。`,
        `recorded=${String(run.raw_response_chars)} recomputed=${toCodePoints(rawResponse).length}`,
      );
    }

    const reparsed = parseSemanticVerdict(rawResponse);
    if (
      run.parseable_schema_valid !== reparsed.parseable_schema_valid ||
      run.exact_output_contract_valid !== reparsed.exact_output_contract_valid
    ) {
      fail(
        'EVALUATION_RESPONSE_MISMATCH',
        `${label} の parse 判定を再計算すると記録と一致しません。`,
        `recorded=${String(run.parseable_schema_valid)}/${String(run.exact_output_contract_valid)} recomputed=${reparsed.parseable_schema_valid}/${reparsed.exact_output_contract_valid}`,
      );
    }
    if (JSON.stringify(run.parsed_output ?? null) !== JSON.stringify(reparsed.parsed_output)) {
      fail(
        'EVALUATION_RESPONSE_MISMATCH',
        `${label}.parsed_output が raw_response から再現しません。`,
        `recorded=${JSON.stringify(run.parsed_output ?? null)} recomputed=${JSON.stringify(reparsed.parsed_output)}`,
      );
    }
    // The error text itself is not pinned — a transport failure and a parse
    // failure word themselves differently, and neither wording decides
    // anything. What is pinned is that an error and a usable verdict are
    // mutually exclusive.
    if ((run.error === null) !== reparsed.parseable_schema_valid) {
      fail(
        'EVALUATION_RESPONSE_MISMATCH',
        `${label}.error が parse 判定と矛盾しています。`,
        `error=${JSON.stringify(run.error)} parseable=${reparsed.parseable_schema_valid}`,
      );
    }

    rederivedRuns.push({
      run_index: index + 1,
      latency_ms: typeof run.latency_ms === 'number' ? run.latency_ms : 0,
      request_sha256: expectedRequestSha,
      raw_response: rawResponse,
      raw_response_sha256: sha256OfText(rawResponse),
      raw_response_chars: toCodePoints(rawResponse).length,
      parseable_schema_valid: reparsed.parseable_schema_valid,
      exact_output_contract_valid: reparsed.exact_output_contract_valid,
      parsed_output: reparsed.parsed_output,
      error: (run.error ?? null) as string | null,
    });
  });

  // --- The vote and the decision ------------------------------------------
  const tally = veto
    ? null
    : tallySemanticRuns(rederivedRuns, SEMANTIC_REQUEST_CONTRACT.repeats);
  const decision = deriveSemanticDecision(guard.mismatch, tally);
  const decisionSection = raw.decision as Record<string, unknown>;

  if (!isSemanticDecisionValue(decisionSection.value)) {
    fail(
      'EVALUATION_DECISION_MISMATCH',
      'decision.value が changed / review 以外です。semantic-h3-v1 は preserved を出しません。',
      `recorded=${String(decisionSection.value)}`,
    );
  }
  if (decisionSection.value !== decision.value || decisionSection.by !== decision.by) {
    fail(
      'EVALUATION_DECISION_MISMATCH',
      'decision を再導出すると記録と一致しません。',
      `recorded=${String(decisionSection.value)}/${String(decisionSection.by)} recomputed=${decision.value}/${decision.by}`,
    );
  }

  return raw as unknown as SemanticEvaluationV4;
}
