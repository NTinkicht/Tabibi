#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

POLICY_PATH = Path('.l5/continuity.json')
MAX_PAGES = 10


def gh(path: str):
    result = subprocess.run(['gh', 'api', path], text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f'GitHub API failed: {path}')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def paged(repo: str, path: str):
    items = []
    for page in range(1, MAX_PAGES + 1):
        sep = '&' if '?' in path else '?'
        batch = gh(f'repos/{repo}/{path}{sep}per_page=100&page={page}')
        if not isinstance(batch, list):
            raise RuntimeError('PAGINATED_RESPONSE_INVALID')
        items.extend(batch)
        if len(batch) < 100:
            return items
    raise RuntimeError('PAGINATION_BOUND_EXCEEDED')


def label_names(item: dict) -> set[str]:
    names = set()
    for label in item.get('labels') or []:
        name = label.get('name') if isinstance(label, dict) else label
        if isinstance(name, str):
            names.add(name.lower())
    return names


def active_prs(pulls: list[dict], repo: str, base: str) -> list[int]:
    result = []
    for pr in pulls:
        head_repo = ((pr.get('head') or {}).get('repo') or {}).get('full_name')
        if (pr.get('base') or {}).get('ref') == base and head_repo == repo:
            if isinstance(pr.get('number'), int):
                result.append(pr['number'])
    return sorted(result)


def ready_issues(issues: list[dict], ready: set[str], blocked: set[str]) -> list[dict]:
    result = []
    for issue in issues:
        if issue.get('pull_request') is not None or issue.get('state') != 'open':
            continue
        labels = label_names(issue)
        if not labels.intersection(ready) or labels.intersection(blocked):
            continue
        if isinstance(issue.get('number'), int):
            result.append(issue)
    return sorted(result, key=lambda row: row['number'])


def reconcile(policy: dict, repo: str) -> dict:
    if policy.get('repository') != repo:
        raise RuntimeError('POLICY_REPOSITORY_MISMATCH')
    if policy.get('mutation_mode') != 'PLAN_ONLY':
        raise RuntimeError('UNREVIEWED_MUTATION_MODE')
    target = int(policy['target_open_prs'])
    base = str(policy.get('base_branch') or 'main')
    pulls = active_prs(paged(repo, 'pulls?state=open'), repo, base)
    deficit = max(0, target - len(pulls))
    issues = paged(repo, 'issues?state=open')
    candidates = ready_issues(
        issues,
        {x.lower() for x in policy.get('ready_labels', [])},
        {x.lower() for x in policy.get('blocking_labels', [])},
    )
    selected = candidates[:deficit]
    return {
        'repository': repo,
        'phase': policy['phase'],
        'mutation_mode': policy['mutation_mode'],
        'target_open_prs': target,
        'active_prs': pulls,
        'deficit': deficit,
        'selected_ready_issues': [
            {'number': x['number'], 'title': x.get('title')} for x in selected
        ],
        'unfilled_slots': max(0, deficit - len(selected)),
        'status': 'QUOTA_SATISFIED' if deficit == 0 else (
            'REPLENISHMENT_PLANNED' if selected else 'IDLE_CAPACITY_NO_READY_WORK'
        ),
    }


def selftest() -> None:
    policy = {
        'repository': 'NTinkicht/Tabibi', 'phase': 'L4.1_CONTINUITY',
        'mutation_mode': 'PLAN_ONLY', 'target_open_prs': 3, 'base_branch': 'main',
        'ready_labels': ['l5-ready', 'l4-ready'],
        'blocking_labels': ['l5-blocked', 'human-only'],
    }
    pulls = [
        {'number': 7, 'base': {'ref': 'main'}, 'head': {'repo': {'full_name': 'NTinkicht/Tabibi'}}},
        {'number': 8, 'base': {'ref': 'dev'}, 'head': {'repo': {'full_name': 'NTinkicht/Tabibi'}}},
    ]
    assert active_prs(pulls, policy['repository'], 'main') == [7]
    issues = [
        {'number': 3, 'state': 'open', 'labels': [{'name': 'l5-ready'}]},
        {'number': 2, 'state': 'open', 'labels': [{'name': 'l5-ready'}, {'name': 'human-only'}]},
        {'number': 4, 'state': 'open', 'labels': []},
    ]
    assert [x['number'] for x in ready_issues(issues, {'l5-ready'}, {'human-only'})] == [3]
    print('l5_continuity selftest PASS')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return 0
    repo = os.environ.get('GITHUB_REPOSITORY')
    if not repo:
        raise SystemExit('L5_BLOCKED: GITHUB_REPOSITORY missing')
    policy = json.loads(POLICY_PATH.read_text(encoding='utf-8'))
    print(json.dumps(reconcile(policy, repo), indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
