import type { EvaluatorId } from '@/evaluation/createEvaluation';

/**
 * Running the evaluators a Result is still missing, one POST at a time.
 *
 * This is orchestration only. Every job is the same `POST /api/evaluations`
 * the single-evaluator buttons send, so one job is still one immutable
 * Evaluation, written once, by the server, from evidence the client never
 * supplies. There is no batch endpoint and no batch writer.
 *
 * Three rules the queue exists to keep:
 *
 * - **Deterministic order.** Results in the order the listing returned them,
 *   evaluators in the order the server declared (`ComparisonRun.evaluator_ids`,
 *   which is `EVALUATOR_IDS`). The order is never restated here.
 * - **Never parallel.** Jobs run strictly one after another — a semantic
 *   evaluation is three model runs, and firing several at once would queue them
 *   against the same local runtime anyway.
 * - **Never across Runs.** `isCurrent` is asked before every job, so a queue
 *   started for one Run stops instead of writing under another.
 *
 * Pure and framework-free, like `selectionLoad.ts`, so the rules can be tested
 * without a renderer.
 */

/** One POST: one evaluator for one Result. */
export interface EvaluationJob {
  resultId: string;
  evaluatorId: EvaluatorId;
}

export interface EvaluationPlan {
  /** What will run, in order. */
  jobs: EvaluationJob[];
  /** What will not: a verified Evaluation for that evaluator already exists. */
  skipped: EvaluationJob[];
}

export interface JobFailure {
  resultId: string;
  evaluatorId: EvaluatorId;
  kind: string;
  message: string;
}

export type JobResult = { ok: true } | { ok: false; error: { kind: string; message: string } };

export interface QueueOutcome {
  succeeded: EvaluationJob[];
  failed: JobFailure[];
  skipped: EvaluationJob[];
  /**
   * `stale` when the Run stopped being the selected one mid-queue: the jobs
   * already sent stand as their own artifacts, and nothing further is sent.
   */
  stopped: 'completed' | 'stale';
  /** At least one Evaluation was created, so the view is now behind the evidence. */
  created: boolean;
}

export interface QueueDeps {
  /** Sends one job. Never throws: a failure comes back as `ok: false`. */
  execute: (job: EvaluationJob) => Promise<JobResult>;
  /** Is the Run this queue was started for still the selected one? */
  isCurrent: () => boolean;
}

/** The shape this module needs from one listed Evaluation. */
export type ListedEvaluationLike =
  | { status: 'verified'; evaluation: { evaluator: { id: string } } }
  | { status: 'rejected' };

/** The shape this module needs from one listed Result. */
export interface ListedResultLike {
  status: 'verified' | 'rejected';
  resultId: string;
  integrityTrust?: 'sealed' | 'legacy-unsealed';
}

/**
 * The evaluators that already have a verified Evaluation for this Result.
 *
 * Rejected artifacts are deliberately not counted: a rejected Evaluation
 * carries no trustworthy evaluator id, and "there is evidence that did not
 * verify" is not "this evaluator has been run". Re-running is then the same
 * act the single-evaluator button already performs.
 */
export function verifiedEvaluatorIdsOf(entries: readonly ListedEvaluationLike[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.status === 'verified') ids.add(entry.evaluation.evaluator.id);
  }
  return ids;
}

/**
 * Only a sealed, verified Result can be evaluated.
 *
 * The same rule the four buttons already follow: a legacy unsealed Result is
 * out of scope for strict evaluation, and a Result that did not verify has
 * nothing to evaluate against. A batch must not make either evaluable.
 */
export function isEvaluableResult(entry: ListedResultLike): boolean {
  return entry.status === 'verified' && entry.integrityTrust === 'sealed';
}

/** What one Result still needs, in the server's evaluator order. */
export function planForResult(input: {
  resultId: string;
  evaluatorOrder: readonly EvaluatorId[];
  verifiedEvaluatorIds: ReadonlySet<string>;
}): EvaluationPlan {
  const jobs: EvaluationJob[] = [];
  const skipped: EvaluationJob[] = [];
  for (const evaluatorId of input.evaluatorOrder) {
    const job = { resultId: input.resultId, evaluatorId };
    if (input.verifiedEvaluatorIds.has(evaluatorId)) skipped.push(job);
    else jobs.push(job);
  }
  return { jobs, skipped };
}

/** What a whole Run still needs: every evaluable Result, in listing order. */
export function planForRun(input: {
  results: readonly ListedResultLike[];
  evaluatorOrder: readonly EvaluatorId[];
  verifiedEvaluatorIdsFor: (resultId: string) => ReadonlySet<string>;
}): EvaluationPlan {
  const jobs: EvaluationJob[] = [];
  const skipped: EvaluationJob[] = [];
  for (const result of input.results) {
    if (!isEvaluableResult(result)) continue;
    const plan = planForResult({
      resultId: result.resultId,
      evaluatorOrder: input.evaluatorOrder,
      verifiedEvaluatorIds: input.verifiedEvaluatorIdsFor(result.resultId),
    });
    jobs.push(...plan.jobs);
    skipped.push(...plan.skipped);
  }
  return { jobs, skipped };
}

/**
 * Send the plan, one job at a time.
 *
 * A failed job is recorded and the queue moves on: the operator sees which
 * evaluator failed and why, and nothing is retried on their behalf. The queue
 * stops early only when the Run it belongs to is no longer the selected one.
 */
export async function runEvaluationQueue(
  plan: EvaluationPlan,
  deps: QueueDeps,
): Promise<QueueOutcome> {
  const succeeded: EvaluationJob[] = [];
  const failed: JobFailure[] = [];
  const skipped = [...plan.skipped];

  for (const job of plan.jobs) {
    if (!deps.isCurrent()) {
      return { succeeded, failed, skipped, stopped: 'stale', created: succeeded.length > 0 };
    }
    const result = await deps.execute(job);
    if (result.ok) succeeded.push(job);
    else failed.push({ ...job, kind: result.error.kind, message: result.error.message });
  }

  return { succeeded, failed, skipped, stopped: 'completed', created: succeeded.length > 0 };
}

/** Counts for the completion line. No grade, no ranking — three tallies. */
export function queueCounts(outcome: QueueOutcome): {
  succeeded: number;
  failed: number;
  skipped: number;
} {
  return {
    succeeded: outcome.succeeded.length,
    failed: outcome.failed.length,
    skipped: outcome.skipped.length,
  };
}
