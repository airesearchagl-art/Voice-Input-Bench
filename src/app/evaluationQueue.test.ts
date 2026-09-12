import { describe, expect, it } from 'vitest';
import type { EvaluatorId } from '@/evaluation/createEvaluation';
import {
  isEvaluableResult,
  planForResult,
  planForRun,
  queueCounts,
  runEvaluationQueue,
  verifiedEvaluatorIdsOf,
  type EvaluationJob,
  type JobResult,
  type ListedEvaluationLike,
  type ListedResultLike,
} from './evaluationQueue';

/**
 * The batch is orchestration only: same POST, one at a time, never across Runs.
 *
 * No renderer is involved. The rules being checked are selection, order,
 * sequencing and stale-Run safety, none of which are rendering rules.
 */

/** As the server declares it (`ComparisonRun.evaluator_ids`); never restated by the UI. */
const ORDER: readonly EvaluatorId[] = [
  'raw-char-v1',
  'surface-normalized-char-v1',
  'critical-info-v1',
  'semantic-h3-v1',
];

const R1 = '20260911T010100000Z-00000001';
const R2 = '20260911T010200000Z-00000002';
const LEGACY = '20260911T010300000Z-00000003';
const REJECTED = '20260911T010400000Z-00000004';

const verified = (id: string): ListedEvaluationLike => ({
  status: 'verified',
  evaluation: { evaluator: { id } },
});
const rejected = (): ListedEvaluationLike => ({ status: 'rejected' });

const sealedResult = (resultId: string): ListedResultLike => ({
  status: 'verified',
  resultId,
  integrityTrust: 'sealed',
});

const ok: JobResult = { ok: true };
const failure = (kind: string): JobResult => ({ ok: false, error: { kind, message: `${kind} です。` } });

describe('missing selection', () => {
  it('skips an evaluator that already has a verified Evaluation', () => {
    const plan = planForResult({
      resultId: R1,
      evaluatorOrder: ORDER,
      verifiedEvaluatorIds: verifiedEvaluatorIdsOf([verified('raw-char-v1'), verified('semantic-h3-v1')]),
    });

    expect(plan.jobs).toEqual([
      { resultId: R1, evaluatorId: 'surface-normalized-char-v1' },
      { resultId: R1, evaluatorId: 'critical-info-v1' },
    ]);
    expect(plan.skipped).toEqual([
      { resultId: R1, evaluatorId: 'raw-char-v1' },
      { resultId: R1, evaluatorId: 'semantic-h3-v1' },
    ]);
  });

  it('treats an evaluator with only rejected artifacts as missing', () => {
    // A rejected Evaluation carries no trustworthy evaluator id, so it is not
    // evidence that this evaluator has run.
    const ids = verifiedEvaluatorIdsOf([rejected(), rejected()]);
    expect(ids.size).toBe(0);

    const plan = planForResult({ resultId: R1, evaluatorOrder: ORDER, verifiedEvaluatorIds: ids });
    expect(plan.jobs.map((job) => job.evaluatorId)).toEqual([...ORDER]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('deterministic order', () => {
  it('follows the server evaluator order, and the listing order of Results', () => {
    const plan = planForRun({
      results: [sealedResult(R1), sealedResult(R2)],
      evaluatorOrder: ORDER,
      verifiedEvaluatorIdsFor: () => new Set<string>(),
    });

    expect(plan.jobs).toEqual([
      { resultId: R1, evaluatorId: 'raw-char-v1' },
      { resultId: R1, evaluatorId: 'surface-normalized-char-v1' },
      { resultId: R1, evaluatorId: 'critical-info-v1' },
      { resultId: R1, evaluatorId: 'semantic-h3-v1' },
      { resultId: R2, evaluatorId: 'raw-char-v1' },
      { resultId: R2, evaluatorId: 'surface-normalized-char-v1' },
      { resultId: R2, evaluatorId: 'critical-info-v1' },
      { resultId: R2, evaluatorId: 'semantic-h3-v1' },
    ]);
  });

  it('uses whatever order it is given, rather than one of its own', () => {
    const reversed = [...ORDER].reverse();
    const plan = planForResult({
      resultId: R1,
      evaluatorOrder: reversed,
      verifiedEvaluatorIds: new Set<string>(),
    });
    expect(plan.jobs.map((job) => job.evaluatorId)).toEqual(reversed);
  });
});

describe('sequential execution', () => {
  it('starts the next job only after the previous one settles', async () => {
    const events: string[] = [];
    let inFlight = 0;
    const plan = planForResult({ resultId: R1, evaluatorOrder: ORDER, verifiedEvaluatorIds: new Set<string>() });

    const outcome = await runEvaluationQueue(plan, {
      isCurrent: () => true,
      execute: async (job) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        events.push(`start:${job.evaluatorId}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push(`end:${job.evaluatorId}`);
        inFlight -= 1;
        return ok;
      },
    });

    expect(outcome.succeeded).toHaveLength(4);
    expect(events).toEqual([
      'start:raw-char-v1',
      'end:raw-char-v1',
      'start:surface-normalized-char-v1',
      'end:surface-normalized-char-v1',
      'start:critical-info-v1',
      'end:critical-info-v1',
      'start:semantic-h3-v1',
      'end:semantic-h3-v1',
    ]);
  });
});

describe('partial failure', () => {
  it('records the failure, carries on, and never retries', async () => {
    const attempts: EvaluationJob[] = [];
    const plan = planForResult({
      resultId: R1,
      evaluatorOrder: ORDER.slice(0, 3),
      verifiedEvaluatorIds: new Set<string>(),
    });

    const outcome = await runEvaluationQueue(plan, {
      isCurrent: () => true,
      execute: async (job) => {
        attempts.push(job);
        return job.evaluatorId === 'surface-normalized-char-v1' ? failure('SEMANTIC_RUNTIME_UNAVAILABLE') : ok;
      },
    });

    expect(attempts).toHaveLength(3);
    expect(queueCounts(outcome)).toEqual({ succeeded: 2, failed: 1, skipped: 0 });
    expect(outcome.failed).toEqual([
      {
        resultId: R1,
        evaluatorId: 'surface-normalized-char-v1',
        kind: 'SEMANTIC_RUNTIME_UNAVAILABLE',
        message: 'SEMANTIC_RUNTIME_UNAVAILABLE です。',
      },
    ]);
    expect(outcome.stopped).toBe('completed');
    // One attempt per job: the failed one is not sent again.
    expect(attempts.filter((job) => job.evaluatorId === 'surface-normalized-char-v1')).toHaveLength(1);
  });
});

describe('stale Run', () => {
  it('stops instead of sending the rest under another Run', async () => {
    const attempts: EvaluationJob[] = [];
    let current = true;
    const plan = planForRun({
      results: [sealedResult(R1), sealedResult(R2)],
      evaluatorOrder: ORDER,
      verifiedEvaluatorIdsFor: () => new Set<string>(),
    });

    const outcome = await runEvaluationQueue(plan, {
      isCurrent: () => current,
      execute: async (job) => {
        attempts.push(job);
        // The operator switches Run while the first job is in flight.
        current = false;
        return ok;
      },
    });

    expect(attempts).toEqual([{ resultId: R1, evaluatorId: 'raw-char-v1' }]);
    expect(outcome.stopped).toBe('stale');
    expect(outcome.succeeded).toHaveLength(1);
    expect(outcome.created).toBe(true);
  });

  it('sends nothing at all when the Run has already moved on', async () => {
    const attempts: EvaluationJob[] = [];
    const plan = planForResult({ resultId: R1, evaluatorOrder: ORDER, verifiedEvaluatorIds: new Set<string>() });

    const outcome = await runEvaluationQueue(plan, {
      isCurrent: () => false,
      execute: async (job) => {
        attempts.push(job);
        return ok;
      },
    });

    expect(attempts).toEqual([]);
    expect(outcome).toEqual({
      succeeded: [],
      failed: [],
      skipped: [],
      stopped: 'stale',
      created: false,
    });
  });
});

describe('verified skip', () => {
  it('sends no request for an evaluator that already verified', async () => {
    const attempts: EvaluationJob[] = [];
    const plan = planForResult({
      resultId: R1,
      evaluatorOrder: ORDER,
      verifiedEvaluatorIds: verifiedEvaluatorIdsOf(ORDER.map((id) => verified(id))),
    });

    const outcome = await runEvaluationQueue(plan, {
      isCurrent: () => true,
      execute: async (job) => {
        attempts.push(job);
        return ok;
      },
    });

    expect(plan.jobs).toEqual([]);
    expect(attempts).toEqual([]);
    expect(queueCounts(outcome)).toEqual({ succeeded: 0, failed: 0, skipped: 4 });
    expect(outcome.created).toBe(false);
  });
});

describe('Result eligibility', () => {
  it('is exactly the rule the four buttons follow: sealed and verified', () => {
    expect(isEvaluableResult(sealedResult(R1))).toBe(true);
    expect(isEvaluableResult({ status: 'verified', resultId: LEGACY, integrityTrust: 'legacy-unsealed' })).toBe(false);
    expect(isEvaluableResult({ status: 'rejected', resultId: REJECTED, integrityTrust: 'sealed' })).toBe(false);
    expect(isEvaluableResult({ status: 'rejected', resultId: REJECTED })).toBe(false);
  });

  it('leaves legacy and rejected Results out of a Run plan entirely', () => {
    const plan = planForRun({
      results: [
        sealedResult(R1),
        { status: 'verified', resultId: LEGACY, integrityTrust: 'legacy-unsealed' },
        { status: 'rejected', resultId: REJECTED, integrityTrust: 'sealed' },
      ],
      evaluatorOrder: ORDER,
      verifiedEvaluatorIdsFor: () => new Set<string>(),
    });

    expect(new Set(plan.jobs.map((job) => job.resultId))).toEqual(new Set([R1]));
    expect(new Set(plan.skipped.map((job) => job.resultId))).toEqual(new Set());
  });
});

describe('what the caller reloads on', () => {
  it('reports that evidence was created exactly when at least one job succeeded', async () => {
    const plan = planForResult({
      resultId: R1,
      evaluatorOrder: ORDER.slice(0, 2),
      verifiedEvaluatorIds: new Set<string>(),
    });

    const allFailed = await runEvaluationQueue(plan, {
      isCurrent: () => true,
      execute: async () => failure('EVALUATION_RESULT_NOT_SEALED'),
    });
    expect(allFailed.created).toBe(false);
    expect(queueCounts(allFailed)).toEqual({ succeeded: 0, failed: 2, skipped: 0 });

    const someCreated = await runEvaluationQueue(plan, {
      isCurrent: () => true,
      execute: async (job) => (job.evaluatorId === 'raw-char-v1' ? ok : failure('X_FAILED')),
    });
    expect(someCreated.created).toBe(true);
  });
});
