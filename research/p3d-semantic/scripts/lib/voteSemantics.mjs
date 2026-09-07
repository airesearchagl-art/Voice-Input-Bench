/**
 * What a set of repeated runs actually agreed on.
 *
 * R1 recorded one flag, `unanimous`, computed over the *valid* runs only. Two
 * runs that agreed and one that could not be parsed came out as unanimous, and
 * a hybrid rule that trusted the flag treated "the model answered twice and
 * failed once" as "the model answered three times the same way". Those are not
 * the same evidence and must not be the same field.
 *
 * So there are two, and both are reported everywhere:
 *
 *   - `valid_vote_unanimous` — among the runs that produced a verdict at all,
 *     every verdict said the same thing. It says nothing about how many runs
 *     that was.
 *   - `full_run_unanimous` — every requested run produced a verdict, and every
 *     verdict said the same thing. This is the only one an automated decision
 *     may rest on.
 *
 * `invalid` here means exactly `parseable_schema_valid === false`: no verdict
 * could be recovered from the reply. A reply that was parseable but arrived
 * wrapped in a fence or a sentence is **not** invalid — that is
 * `exact_output_contract_valid`, a separate record of whether the model followed
 * the requested format, and folding it in here would quietly discard runs the
 * model got right.
 */

/**
 * @param {Array<{parseable_schema_valid: boolean, verdict: {meaning_preserved: boolean}|null}>} runs
 * @param {number} requestedRepeats how many runs were asked for
 */
export function tallyRuns(runs, requestedRepeats) {
  const all = Array.isArray(runs) ? runs : [];
  const valid = all.filter((run) => run.parseable_schema_valid === true);
  const invalidRuns = all.length - valid.length;
  const preservedVotes = valid.filter((run) => run.verdict?.meaning_preserved === true).length;

  const validVoteUnanimous =
    valid.length > 0 && (preservedVotes === 0 || preservedVotes === valid.length);

  // Every requested run has to have landed. A missing run is missing evidence,
  // whether it failed to parse or was never made.
  const fullRunUnanimous =
    validVoteUnanimous &&
    invalidRuns === 0 &&
    requestedRepeats > 0 &&
    valid.length === requestedRepeats;

  // Majority of the *valid* runs. An invalid run is not a vote for anything, so
  // it neither carries nor blocks the majority — that is what
  // `full_run_unanimous` is for.
  const majorityLabel =
    valid.length === 0 ? null : preservedVotes * 2 > valid.length ? 'preserved' : 'changed';

  return {
    requested_runs: requestedRepeats,
    completed_runs: all.length,
    valid_runs: valid.length,
    invalid_runs: invalidRuns,
    preserved_votes: preservedVotes,
    changed_votes: valid.length - preservedVotes,
    valid_vote_unanimous: validVoteUnanimous,
    full_run_unanimous: fullRunUnanimous,
    majority_label: majorityLabel,
  };
}
