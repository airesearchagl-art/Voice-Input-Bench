#!/usr/bin/env node
/**
 * Method B — local LLM rubric (semantic-rubric-v1).
 *
 * Sends each probe through a fixed prompt on a local runtime and parses one
 * JSON verdict. Every pair is run more than once, because a judge that answers
 * differently on the same input is not a judge a bench can quote.
 *
 * The prompt is frozen and its digest is recorded with every result. A rubric
 * edited between runs would make two result files look comparable when they are
 * measuring different instructions.
 *
 * Two compliance levels are tracked separately, because they answer different
 * questions:
 *
 *   - `parseable_schema_valid` — a JSON object with every required field of the
 *     right type could be recovered, whatever wrapping it arrived in.
 *   - `exact_output_contract_valid` — the reply was one JSON object and nothing
 *     else, which is what the prompt actually asked for.
 *
 * Reporting only the first would let "0% invalid" describe a model that never
 * once followed the format.
 *
 * Agreement across repeats is recorded at two levels for the same reason, and
 * only the strict one may carry an automated decision:
 *
 *   - `valid_vote_unanimous` — the runs that produced a verdict all agreed.
 *   - `full_run_unanimous` — every requested run produced a verdict, and they
 *     all agreed.
 *
 * Two agreeing runs and one unparseable reply satisfies the first and not the
 * second. See `lib/voteSemantics.mjs`.
 *
 * Fail Closed on a malformed response: an unrecoverable reply is recorded as
 * `invalid` and counted, never coerced into a `preserved` or repaired into
 * something the model did not say.
 *
 * Two local API shapes are supported because both are common on a developer
 * machine: Ollama's native `/api/chat` and the OpenAI-compatible
 * `/v1/chat/completions`. Both go through the loopback guard.
 *
 * Usage:
 *   node scripts/run-llm-rubric.mjs [--endpoint http://127.0.0.1:11434]
 *                                   [--model <id>] [--repeats 3]
 *                                   [--api ollama|openai]
 *                                   [--input raw|surface]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NotLoopbackError, assertLoopbackEndpoint, loopbackFetch } from './lib/localGuard.mjs';
import { RESEARCH_ROOT, loadProbes, sha256OfFile, sha256OfText, textsFor } from './lib/probes.mjs';
import { environmentSnapshot, mean, median, writeEvidence } from './lib/evidence.mjs';
import { surfaceNormalizeMirror } from './lib/surfaceNormalizeMirror.mjs';
import { lmStudioRuntimeInfo, ollamaRuntimeInfo } from './lib/runtimeInfo.mjs';
import { tallyRuns } from './lib/voteSemantics.mjs';
import { goldStatus } from './lib/goldStatus.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.1:8b';
const DEFAULT_API = 'ollama';
const DEFAULT_REPEATS = 3;
const DEFAULT_INPUT = 'raw';
const NUM_PREDICT = 600;
const REQUEST_TIMEOUT_MS = 300_000;

const PROMPT_FILE = path.join(RESEARCH_ROOT, 'prompts', 'semantic-rubric-v1.md');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const endpoint = arg('endpoint', DEFAULT_ENDPOINT);
const model = arg('model', DEFAULT_MODEL);
const api = arg('api', DEFAULT_API);
const inputVariant = arg('input', DEFAULT_INPUT);
const repeats = Number(arg('repeats', String(DEFAULT_REPEATS)));

const REQUIRED_FIELDS = [
  'meaning_preserved',
  'severity',
  'negation',
  'direction_location',
  'instruction_action',
  'critical_fact',
  'domain_term',
  'reason_codes',
  'short_rationale',
];

const SEVERITIES = new Set(['none', 'minor', 'major', 'critical']);

/**
 * Read one verdict out of a model reply.
 *
 * Tolerant about *packaging* — a code fence or a leading sentence is a
 * formatting habit, not a different answer — and strict about *content*. A
 * missing field or a wrong type makes the whole reply invalid.
 *
 * `exact` records whether the reply needed any of that tolerance, so the two
 * compliance rates can be reported apart.
 */
export function parseVerdict(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, exact: false, error: 'empty response' };
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, exact: false, error: 'no JSON object in response' };
  }

  const objectText = candidate.slice(start, end + 1);
  // Exact means the whole reply *was* the object: no fence, no preamble, no
  // trailing remark.
  const exact = !fenced && start === 0 && end === candidate.length - 1;

  let parsed;
  try {
    parsed = JSON.parse(objectText);
  } catch (error) {
    return { ok: false, exact, error: `JSON parse failed: ${error.message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, exact, error: 'response is not a JSON object' };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) return { ok: false, exact, error: `missing field: ${field}` };
  }
  for (const flag of [
    'meaning_preserved',
    'negation',
    'direction_location',
    'instruction_action',
    'critical_fact',
    'domain_term',
  ]) {
    if (typeof parsed[flag] !== 'boolean') {
      return { ok: false, exact, error: `${flag} is not a boolean` };
    }
  }
  if (!SEVERITIES.has(parsed.severity)) {
    return { ok: false, exact, error: `severity ${String(parsed.severity)} is not a severity` };
  }
  if (!Array.isArray(parsed.reason_codes) || !parsed.reason_codes.every((c) => typeof c === 'string')) {
    return { ok: false, exact, error: 'reason_codes is not an array of strings' };
  }
  if (typeof parsed.short_rationale !== 'string') {
    return { ok: false, exact, error: 'short_rationale is not a string' };
  }

  return { ok: true, exact, verdict: parsed };
}

function buildPrompt(template, texts) {
  // The template carries two placeholders and nothing else is substituted, so
  // no probe field can reach the model by being interpolated somewhere new.
  return template
    .replace('<<<REFERENCE>>>', texts.reference)
    .replace('<<<HYPOTHESIS>>>', texts.hypothesis);
}

/** What the runtime is actually asked for, recorded verbatim in the evidence. */
function requestBodyFor(prompt) {
  if (api === 'ollama') {
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0, num_predict: NUM_PREDICT },
      stream: false,
    };
  }
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: NUM_PREDICT,
    stream: false,
  };
}

async function ask(base, prompt) {
  const body = requestBodyFor(prompt);
  const url = api === 'ollama' ? `${base}/api/chat` : `${base}/v1/chat/completions`;
  const serialized = JSON.stringify(body);

  const response = await loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: serialized,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} -> HTTP ${response.status}: ${await response.text()}`);
  }
  const parsed = await response.json();
  const content = api === 'ollama' ? parsed?.message?.content : parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('chat response had no message content');
  return { content, requestSha256: sha256OfText(serialized) };
}

async function main() {
  if (inputVariant !== 'raw' && inputVariant !== 'surface') {
    console.error(`REFUSED  unknown --input ${inputVariant} (expected raw or surface)`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  let base;
  try {
    base = assertLoopbackEndpoint(endpoint).origin;
  } catch (error) {
    if (error instanceof NotLoopbackError) {
      console.error(`REFUSED  ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const template = readFileSync(PROMPT_FILE, 'utf8');
  const promptSha256 = sha256OfFile(PROMPT_FILE);
  const { probes, sha256, corpus } = loadProbes();

  const runtime =
    api === 'ollama'
      ? await ollamaRuntimeInfo(base, model)
      : await lmStudioRuntimeInfo(base, model);

  const results = [];
  const latencies = [];

  for (const probe of probes) {
    const rawTexts = textsFor(probe);
    const texts =
      inputVariant === 'surface'
        ? {
            reference: surfaceNormalizeMirror(rawTexts.reference),
            hypothesis: surfaceNormalizeMirror(rawTexts.hypothesis),
          }
        : rawTexts;
    const prompt = buildPrompt(template, texts);
    const runs = [];

    for (let attempt = 1; attempt <= repeats; attempt += 1) {
      const began = performance.now();
      let raw = null;
      let requestSha256 = null;
      let parsed;
      try {
        const asked = await ask(base, prompt);
        raw = asked.content;
        requestSha256 = asked.requestSha256;
        parsed = parseVerdict(raw);
      } catch (error) {
        parsed = { ok: false, exact: false, error: error.message };
      }
      const elapsed = performance.now() - began;
      latencies.push(elapsed);

      runs.push({
        attempt,
        // The two compliance levels, kept apart.
        parseable_schema_valid: parsed.ok,
        exact_output_contract_valid: parsed.ok && parsed.exact === true,
        latency_ms: Math.round(elapsed),
        request_sha256: requestSha256,
        // The reply itself is customer-derived text and is not written to git.
        // Its digest is enough to prove two runs produced the same bytes.
        raw_response_sha256: raw === null ? null : sha256OfText(raw),
        raw_response_chars: raw === null ? null : Array.from(raw).length,
        verdict: parsed.ok ? parsed.verdict : null,
        error: parsed.ok ? null : parsed.error,
      });
    }

    const tally = tallyRuns(runs, repeats);
    const identicalBytes =
      new Set(runs.map((run) => run.raw_response_sha256).filter(Boolean)).size <= 1;

    // The proposed label is attached only now, after every request has been made.
    results.push({
      id: probe.id,
      category: probe.category,
      hard_negative: probe.hard_negative,
      proposed_label: probe.gold.label,
      proposed_reason_code: probe.gold.reason_code,
      requested_runs: tally.requested_runs,
      valid_runs: tally.valid_runs,
      invalid_runs: tally.invalid_runs,
      exact_contract_runs: runs.filter((run) => run.exact_output_contract_valid).length,
      preserved_votes: tally.preserved_votes,
      changed_votes: tally.changed_votes,
      // Two levels, never one. Only full_run_unanimous may drive automation.
      valid_vote_unanimous: tally.valid_vote_unanimous,
      full_run_unanimous: tally.full_run_unanimous,
      byte_identical_responses: identicalBytes,
      majority_label: tally.majority_label,
      runs,
    });

    console.log(
      `${probe.id.padEnd(4)} proposed=${probe.gold.label.padEnd(9)} majority=${String(tally.majority_label).padEnd(9)} votes=${tally.preserved_votes}/${tally.valid_runs} ${tally.full_run_unanimous ? 'full-unanimous' : tally.valid_vote_unanimous ? 'valid-unanimous' : 'SPLIT          '} invalid=${tally.invalid_runs} exact=${results.at(-1).exact_contract_runs}/${runs.length}`,
    );
  }

  const evidence = {
    method: 'llm-rubric',
    status: 'OK',
    input_variant: inputVariant,
    gold_provenance: corpus.gold_provenance,
    gold_status: goldStatus(corpus.gold_provenance),
    scoring_caveat: goldStatus(corpus.gold_provenance).caveat,
    ...runtime,
    request_contract: {
      api,
      temperature: 0,
      num_predict: api === 'ollama' ? NUM_PREDICT : null,
      max_tokens: api === 'ollama' ? null : NUM_PREDICT,
      top_p: 'unset (runtime default)',
      seed: 'unset (uncontrolled)',
      response_format: 'unconstrained text; the prompt asks for one JSON object',
      stream: false,
      repeats,
      input_variant: inputVariant,
    },
    prompt_file: 'prompts/semantic-rubric-v1.md',
    prompt_sha256: promptSha256,
    probes_sha256: sha256,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: environmentSnapshot(),
    latency_ms: {
      per_request_mean: Math.round(mean(latencies) ?? 0),
      per_request_median: Math.round(median(latencies) ?? 0),
    },
    results,
  };

  const name = `llm-rubric-results.${inputVariant}.json`;
  console.log(`\nevidence -> ${writeEvidence(name, evidence)}`);
}

if (process.argv[1] && process.argv[1].endsWith('run-llm-rubric.mjs')) {
  await main();
}
