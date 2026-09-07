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
 * Fail Closed on a malformed response: an unparseable or wrong-shaped verdict is
 * recorded as `invalid` and counted, never coerced into a `preserved` or
 * repaired into something the model did not say.
 *
 * Two local API shapes are supported because both are common on a developer
 * machine: Ollama's native `/api/chat` and the OpenAI-compatible
 * `/v1/chat/completions`. Neither is a network dependency — both are checked by
 * the loopback guard before a request is made.
 *
 * Usage:
 *   node scripts/run-llm-rubric.mjs [--endpoint http://127.0.0.1:11434]
 *                                   [--model <id>] [--repeats 3]
 *                                   [--api ollama|openai]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NotLoopbackError, assertLoopbackEndpoint, loopbackFetch } from './lib/localGuard.mjs';
import { RESEARCH_ROOT, loadProbes, sha256OfFile, textsFor } from './lib/probes.mjs';
import { environmentSnapshot, mean, median, writeEvidence } from './lib/evidence.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.1:8b';
const DEFAULT_API = 'ollama';
const DEFAULT_REPEATS = 3;
const REQUEST_TIMEOUT_MS = 300_000;

const PROMPT_FILE = path.join(RESEARCH_ROOT, 'prompts', 'semantic-rubric-v1.md');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const endpoint = arg('endpoint', DEFAULT_ENDPOINT);
const model = arg('model', DEFAULT_MODEL);
const api = arg('api', DEFAULT_API);
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
 */
export function parseVerdict(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'empty response' };
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object in response' };

  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: `JSON parse failed: ${error.message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'response is not a JSON object' };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) return { ok: false, error: `missing field: ${field}` };
  }
  for (const flag of [
    'meaning_preserved',
    'negation',
    'direction_location',
    'instruction_action',
    'critical_fact',
    'domain_term',
  ]) {
    if (typeof parsed[flag] !== 'boolean') return { ok: false, error: `${flag} is not a boolean` };
  }
  if (!SEVERITIES.has(parsed.severity)) {
    return { ok: false, error: `severity ${String(parsed.severity)} is not a severity` };
  }
  if (!Array.isArray(parsed.reason_codes) || !parsed.reason_codes.every((c) => typeof c === 'string')) {
    return { ok: false, error: 'reason_codes is not an array of strings' };
  }
  if (typeof parsed.short_rationale !== 'string') {
    return { ok: false, error: 'short_rationale is not a string' };
  }

  return { ok: true, verdict: parsed };
}

function buildPrompt(template, texts) {
  // The template carries two placeholders and nothing else is substituted, so
  // no probe field can reach the model by being interpolated somewhere new.
  return template
    .replace('<<<REFERENCE>>>', texts.reference)
    .replace('<<<HYPOTHESIS>>>', texts.hypothesis);
}

/** Ollama's native chat API. */
async function askOllama(base, prompt) {
  const response = await loopbackFetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0, num_predict: 600 },
      stream: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`POST /api/chat -> HTTP ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  const content = body?.message?.content;
  if (typeof content !== 'string') throw new Error('chat response had no message content');
  return content;
}

/** The OpenAI-compatible shape, as served by LM Studio and others. */
async function askOpenAiCompatible(base, prompt) {
  const response = await loopbackFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 600,
      stream: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/chat/completions -> HTTP ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('chat completion had no message content');
  return content;
}

async function ask(base, prompt) {
  if (api === 'ollama') return askOllama(base, prompt);
  if (api === 'openai') return askOpenAiCompatible(base, prompt);
  throw new Error(`unknown --api ${api} (expected ollama or openai)`);
}

async function main() {
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
  const { probes, sha256 } = loadProbes();

  const results = [];
  const latencies = [];

  for (const probe of probes) {
    const texts = textsFor(probe);
    const prompt = buildPrompt(template, texts);
    const runs = [];

    for (let attempt = 1; attempt <= repeats; attempt += 1) {
      const began = performance.now();
      let raw;
      let parsed;
      try {
        raw = await ask(base, prompt);
        parsed = parseVerdict(raw);
      } catch (error) {
        parsed = { ok: false, error: error.message };
      }
      const elapsed = performance.now() - began;
      latencies.push(elapsed);

      runs.push(
        parsed.ok
          ? { attempt, valid: true, latency_ms: Math.round(elapsed), verdict: parsed.verdict }
          : {
              attempt,
              valid: false,
              latency_ms: Math.round(elapsed),
              error: parsed.error,
              raw_excerpt: typeof raw === 'string' ? raw.slice(0, 400) : null,
            },
      );
    }

    const valid = runs.filter((run) => run.valid);
    const preservedVotes = valid.filter((run) => run.verdict.meaning_preserved).length;
    const unanimous = valid.length > 0 && (preservedVotes === 0 || preservedVotes === valid.length);
    // Majority of the *valid* runs. An invalid run is not a vote for anything.
    const majority = valid.length === 0 ? null : preservedVotes * 2 > valid.length ? 'preserved' : 'changed';

    // The gold label is attached only now, after every request has been made.
    results.push({
      id: probe.id,
      category: probe.category,
      hard_negative: probe.hard_negative,
      gold_label: probe.gold.label,
      gold_reason_code: probe.gold.reason_code,
      valid_runs: valid.length,
      invalid_runs: runs.length - valid.length,
      preserved_votes: preservedVotes,
      unanimous,
      majority_label: majority,
      runs,
    });

    console.log(
      `${probe.id.padEnd(4)} gold=${probe.gold.label.padEnd(9)} majority=${String(majority).padEnd(9)} votes=${preservedVotes}/${valid.length} ${unanimous ? 'unanimous' : 'SPLIT    '} ${runs.length - valid.length > 0 ? `invalid=${runs.length - valid.length}` : ''}`,
    );
  }

  const evidence = {
    method: 'llm-rubric',
    status: 'OK',
    endpoint: base,
    model,
    api,
    prompt_file: 'prompts/semantic-rubric-v1.md',
    prompt_sha256: promptSha256,
    temperature: 0,
    repeats,
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

  console.log(`\nevidence -> ${writeEvidence('llm-rubric-results.json', evidence)}`);
}

if (process.argv[1] && process.argv[1].endsWith('run-llm-rubric.mjs')) {
  await main();
}
