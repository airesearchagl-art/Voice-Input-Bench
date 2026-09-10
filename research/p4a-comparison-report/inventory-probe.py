"""Read-only probe that regenerates inventory-observations.json.

Reads `data/runs`, `data/results` and `data/evaluations` and reports structure,
identity and counts. It opens nothing for writing and touches no artifact.

Transcript and benchmark sentence text is never emitted: the output is ids,
counts and contract shapes, because the source text is not an approved
repository fixture.

Usage, from the repository root:

    # structure only
    python research/p4a-comparison-report/inventory-probe.py

    # including verified/rejected status, using saved API responses
    #   curl "http://127.0.0.1:3000/api/evaluations?runId=<run>" > r1.json
    python research/p4a-comparison-report/inventory-probe.py r1.json r2.json

Two rules from comparison-contract.md are enforced here, so the numbers this
probe reports are numbers the recommended model could actually produce:

1. **Evaluator groups are built from verified Evaluations only.** A rejected
   Evaluation carries no trustworthy evaluator id in the shape production
   returns, so this probe does not read the `evaluator` field of a failed
   artifact to group it. Rejected Evaluations are counted against their Result
   (or against the Run when they name no Result) instead.

2. **Legacy unsealed Results are not tool evidence.** Their `tool` claim is
   readable and unprovable, so it is reported as a claim.

Verification status is deliberately not recomputed here. It is a property of the
current verifier, and the only honest source for it is the production readback
path — `GET /api/evaluations` — not a reimplementation in a probe.
"""
import collections
import hashlib
import io
import json
import os
import sys

DATA = 'data'
OUT = 'research/p4a-comparison-report/inventory-observations.json'
BASE = 'main@8273d1aad2a981754710661f6a905b61e2eaf6d8'
SEALED_RESULT_SCHEMA = 2


def read_json(path):
    return json.load(io.open(path, encoding='utf-8'))


def file_sha256(path):
    """Byte identity of the artifact as stored, independent of any seal."""
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def load_status(paths):
    """Map evaluation_id -> (status, reason) from saved API responses."""
    status = {}
    for path in paths:
        for entry in read_json(path).get('evaluations', []):
            status[entry['evaluationId']] = (entry['status'], entry.get('reason'))
    return status


def load_results():
    results = {}
    root = os.path.join(DATA, 'results')
    for result_id in sorted(os.listdir(root)):
        path = os.path.join(root, result_id, 'result.json')
        if not os.path.isfile(path):
            continue
        stored = read_json(path)
        schema = stored.get('schema_version')
        results[result_id] = {
            'run_id': stored.get('run_id'),
            'schema_version': schema,
            'sealed': schema == SEALED_RESULT_SCHEMA,
            # Named a claim on purpose: for an unsealed Result nothing proves
            # the tool section was not edited after the fact.
            'claimed_tool_id': (stored.get('tool') or {}).get('id'),
            'file_sha256': file_sha256(path),
        }
    return results


def load_evaluations(status):
    evaluations = {}
    root = os.path.join(DATA, 'evaluations')
    for evaluation_id in sorted(os.listdir(root)):
        path = os.path.join(root, evaluation_id, 'evaluation.json')
        if not os.path.isfile(path):
            continue
        stored = read_json(path)
        state, reason = status.get(evaluation_id, ('(not listed)', None))
        verified = state == 'verified'
        evaluations[evaluation_id] = {
            'schema_version': stored.get('schema_version'),
            'result_id': stored.get('result_id'),
            'status': state,
            'reason': reason,
            # Trusted only for a verified Evaluation. For a rejected one this
            # stays None no matter what the file claims.
            'evaluator_id': (stored.get('evaluator') or {}).get('id') if verified else None,
            'file_sha256': file_sha256(path),
        }
    return evaluations


def main():
    status = load_status(sys.argv[1:])
    results = load_results()
    evaluations = load_evaluations(status)

    groups = collections.defaultdict(list)          # verified only
    unclassified = collections.defaultdict(list)    # rejected, result known
    unattributed = []                               # rejected, no result
    by_schema = collections.Counter()

    for evaluation_id, meta in sorted(evaluations.items()):
        by_schema[meta['schema_version']] += 1
        if meta['status'] == 'verified':
            groups[(meta['result_id'], meta['evaluator_id'])].append(evaluation_id)
        elif meta['result_id'] in results:
            unclassified[meta['result_id']].append(evaluation_id)
        else:
            unattributed.append(evaluation_id)

    rows = []
    for key in sorted(groups, key=lambda k: (str(k[0]), str(k[1]))):
        entries = sorted(groups[key])
        rows.append({
            'result_id': key[0],
            'evaluator_id': key[1],
            'state': {
                'availability': 'available',
                'verified_count': len(entries),
                'multiple_candidates': len(entries) > 1,
                # Only reachable for semantic-h3-v1, and only by comparing
                # decisions. The probe reads identities, not stored verdicts.
                'conflicting_evidence': None,
            },
            # newest verified by id; on a v4 conflict the contract yields no
            # headline at all, which the probe does not attempt to detect.
            'headline_if_newest_verified': entries[-1],
            'verified_evaluation_ids': entries,
        })

    per_result = {}
    for result_id, meta in sorted(results.items()):
        verified_groups = [r for r in rows if r['result_id'] == result_id]
        per_result[result_id] = {
            'run_id': meta['run_id'],
            'sealed': meta['sealed'],
            'claimed_tool_id': meta['claimed_tool_id'],
            'tool_claim_is_unverified': not meta['sealed'],
            'evaluators_with_verified_evidence': sorted(
                g['evaluator_id'] for g in verified_groups),
            'unclassified_rejected_evaluation_ids': sorted(unclassified.get(result_id, [])),
        }

    counts = collections.Counter(s for s, _ in status.values())
    payload = {
        'measured_against': BASE,
        'note': (
            'Read-only. Identities and counts only; no transcript text. '
            'Evaluator groups are verified-only: a rejected Evaluation has no '
            'trustworthy evaluator id, so it is counted against its Result.'
        ),
        'totals': {
            'runs': len(os.listdir(os.path.join(DATA, 'runs'))),
            'results': len(results),
            'sealed_results': sum(1 for m in results.values() if m['sealed']),
            'legacy_unsealed_results': sum(1 for m in results.values() if not m['sealed']),
            'evaluations': len(evaluations),
            'evaluations_by_schema': {
                'v%s' % k: v for k, v in sorted(by_schema.items(), key=lambda kv: str(kv[0]))
            },
            'readback': {
                'listed': len(status),
                'verified': counts['verified'],
                'rejected': counts['rejected'],
                'unexpected': counts['UNEXPECTED'] if 'UNEXPECTED' in counts else 0,
            },
        },
        'results': per_result,
        'evaluator_groups_verified_only': rows,
        'unattributed_rejected_evaluation_ids': sorted(unattributed),
        'artifact_content': {
            'results': {k: {'file_sha256': v['file_sha256']} for k, v in sorted(results.items())},
            'evaluations': {
                k: {'file_sha256': v['file_sha256']} for k, v in sorted(evaluations.items())
            },
        },
        'derived_findings': {
            'groups_with_multiple_verified': [
                {'result_id': r['result_id'], 'evaluator_id': r['evaluator_id'],
                 'verified': r['state']['verified_count']}
                for r in rows if r['state']['multiple_candidates']
            ],
            'results_with_unclassified_rejected': [
                {'result_id': rid, 'unclassified_rejected': len(ids)}
                for rid, ids in sorted(unclassified.items())
            ],
            'legacy_unsealed_result_ids': sorted(
                rid for rid, m in results.items() if not m['sealed']),
            'semantic_review_present': False,
            'semantic_review_note': (
                'No semantic-h3-v1 artifact decided review; '
                'P4-B must cover it with a fixture.'
            ),
            'custom_tool_present': False,
            'custom_tool_note': (
                "Every Result on disk is a built-in tool; the custom 'other' "
                'identity rules need fixtures in P4-B.'
            ),
        },
    }

    io.open(OUT, 'w', encoding='utf-8').write(
        json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    print('wrote %s' % OUT)
    print('verified_groups=%d multiple_verified=%d results_with_unclassified=%d '
          'unattributed=%d' % (
              len(rows),
              len(payload['derived_findings']['groups_with_multiple_verified']),
              len(payload['derived_findings']['results_with_unclassified_rejected']),
              len(unattributed),
          ))


if __name__ == '__main__':
    main()
