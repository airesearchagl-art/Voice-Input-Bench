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

Verification status is deliberately not recomputed here. It is a property of the
current verifier, and the only honest source for it is the production readback
path — `GET /api/evaluations` — not a reimplementation in a probe.
"""
import collections
import io
import json
import os
import sys

DATA = 'data'
OUT = 'research/p4a-comparison-report/inventory-observations.json'
BASE = 'main@8273d1aad2a981754710661f6a905b61e2eaf6d8'


def read_json(path):
    return json.load(io.open(path, encoding='utf-8'))


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
        results[result_id] = {
            'run_id': stored.get('run_id'),
            'tool': (stored.get('tool') or {}).get('id'),
            'schema_version': stored.get('schema_version'),
        }
    return results


def load_groups(status):
    """Group Evaluations by (result_id, evaluator_id), as a comparison would."""
    groups = collections.defaultdict(list)
    by_schema = collections.Counter()
    root = os.path.join(DATA, 'evaluations')
    for evaluation_id in sorted(os.listdir(root)):
        path = os.path.join(root, evaluation_id, 'evaluation.json')
        if not os.path.isfile(path):
            continue
        stored = read_json(path)
        by_schema[stored.get('schema_version')] += 1
        evaluator = (stored.get('evaluator') or {}).get('id')
        if evaluator is None and stored.get('algorithm'):
            # A pre-final v1 artifact names its evaluator `algorithm`.
            evaluator = '(pre-final-v1-shape)'
        state, reason = status.get(evaluation_id, ('(not listed)', None))
        groups[(stored.get('result_id'), evaluator)].append({
            'evaluation_id': evaluation_id,
            'schema_version': stored.get('schema_version'),
            'status': state,
            'reason': reason,
        })
    return groups, by_schema


def classify(entries):
    """Group state as orthogonal dimensions, per comparison-contract.md.

    A single enum lost whichever fact came second. `7cdff2e8 / critical-info-v1`
    is two verified *and* one rejected, and both readings have to survive.
    """
    verified = [e for e in entries if e['status'] == 'verified']
    rejected = [e for e in entries if e['status'] == 'rejected']

    if verified:
        availability = 'available'
    elif rejected:
        availability = 'only_rejected'
    else:
        availability = 'missing'

    state = {
        'availability': availability,
        'verified_count': len(verified),
        'rejected_count': len(rejected),
        'multiple_candidates': len(verified) > 1,
        # Only reachable for semantic-h3-v1, and only by comparing decisions.
        # Not computed here: the probe reads identities, not stored verdicts.
        'conflicting_evidence': None,
    }
    return state, verified


def main():
    status = load_status(sys.argv[1:])
    results = load_results()
    groups, by_schema = load_groups(status)

    rows = []
    for key in sorted(groups, key=lambda k: (str(k[0]), str(k[1]))):
        entries = sorted(groups[key], key=lambda e: e['evaluation_id'])
        state, verified = classify(entries)
        rows.append({
            'result_id': key[0],
            'evaluator_id': key[1],
            'total': len(entries),
            'state': state,
            # The recommended rule: newest verified by id. Null when none verifies.
            # On a v4 conflict the contract yields no headline at all; the probe
            # does not compare decisions, so this stays the unconflicted rule.
            'headline_if_newest_verified': verified[-1]['evaluation_id'] if verified else None,
            'entries': entries,
        })

    counts = collections.Counter(s for s, _ in status.values())
    payload = {
        'measured_against': BASE,
        'note': 'Read-only. Identities and counts only; no transcript text.',
        'totals': {
            'runs': len(os.listdir(os.path.join(DATA, 'runs'))),
            'results': len(results),
            'evaluations': sum(by_schema.values()),
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
        'results': results,
        'evaluation_groups': rows,
        'derived_findings': {
            'groups_with_multiple_verified': [
                {'result_id': r['result_id'], 'evaluator_id': r['evaluator_id'],
                 'verified': r['state']['verified_count'],
                 'rejected': r['state']['rejected_count']}
                for r in rows if r['state']['multiple_candidates']
            ],
            'groups_with_only_rejected': [
                {'result_id': r['result_id'], 'evaluator_id': r['evaluator_id'],
                 'rejected': r['state']['rejected_count']}
                for r in rows if r['state']['availability'] == 'only_rejected'
            ],
            'groups_multiple_candidates_with_rejected_siblings': [
                {'result_id': r['result_id'], 'evaluator_id': r['evaluator_id'],
                 'verified': r['state']['verified_count'],
                 'rejected': r['state']['rejected_count']}
                for r in rows
                if r['state']['multiple_candidates'] and r['state']['rejected_count'] > 0
            ],
            'semantic_review_present': False,
            'semantic_review_note': (
                'No semantic-h3-v1 artifact decided review; '
                'P4-B must cover it with a fixture.'
            ),
        },
    }

    io.open(OUT, 'w', encoding='utf-8').write(
        json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    print('wrote %s' % OUT)
    print('groups=%d multiple_verified=%d only_rejected=%d' % (
        len(rows),
        len(payload['derived_findings']['groups_with_multiple_verified']),
        len(payload['derived_findings']['groups_with_only_rejected']),
    ))


if __name__ == '__main__':
    main()
