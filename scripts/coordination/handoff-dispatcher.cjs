/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const fs = require('node:fs');
const https = require('node:https');

const PAUSED_ACTORS = new Set(['gemini', 'gemini_agent', 'gemini_chat']);
const TEAM_ROOM_ISSUE = 21;

function isCopilotLogin(login = '') {
  return /^(copilot|copilot-swe-agent\[bot\])$/i.test(login);
}

function dedupKey(kind, sha = 'none') {
  return `<!-- tabibi-handoff:${kind}:${sha} -->`;
}

function hasExplicitMergeReadySignal(text = '') {
  return (
    /(?:^|\n)\s*MERGE_READY\s*(?:$|\n)/i.test(text) ||
    /\bPASS(?:_WITH_MINOR_FINDINGS)?\s*\/\s*MERGE_READY\b/i.test(text)
  );
}

function decideHandoff({
  eventName,
  pr,
  review,
  commentBody = '',
  workflowRun,
  ciGreen = false,
}) {
  if (!pr) return null;
  const sha = pr.head?.sha || workflowRun?.head_sha || 'unknown';
  const author = pr.user?.login || '';

  if (eventName === 'workflow_run') {
    if (
      workflowRun?.status !== 'completed' ||
      workflowRun?.conclusion !== 'success'
    )
      return null;
    if (
      workflowRun.head_sha &&
      pr.head?.sha &&
      workflowRun.head_sha !== pr.head.sha
    )
      return null;
    if (isCopilotLogin(author)) {
      return {
        kind: 'copilot-ci-green-review',
        target: 'claude',
        sha,
        message: `HANDOFF_TO_CLAUDE — Copilot-authored PR #${pr.number} exact head \`${sha}\` has green CI. Perform an independent non-author exact-SHA review. Do not modify the branch while gating.`,
      };
    }
    return {
      kind: 'ci-green-review-needed',
      target: 'orchestrator',
      sha,
      message: `CI_GREEN_HANDOFF — PR #${pr.number} exact head \`${sha}\` is green. Reconcile the binding reviewer lease and dispatch an eligible non-author gate; do not infer a reviewer from provider availability alone.`,
    };
  }

  const reviewBody = review?.body || '';
  const reviewState = String(review?.state || '').toLowerCase();
  const combined = `${reviewBody}\n${commentBody}`;
  const changesRequired =
    reviewState === 'changes_requested' ||
    /\bCHANGES_REQUIRED\b/i.test(combined);
  if (changesRequired) {
    if (eventName === 'issue_comment') return null;
    const target = isCopilotLogin(author) ? 'copilot' : 'implementer';
    return {
      kind: 'changes-required-remediation',
      target,
      sha,
      message:
        target === 'copilot'
          ? `@copilot\n\nSAME-BRANCH REMEDIATION — PR #${pr.number} exact head \`${sha}\` has CHANGES_REQUIRED. Address the concrete reviewer findings on this existing canonical branch only, run CI, and hand the new exact SHA to an independent non-author reviewer. Do not open a duplicate PR.`
          : `HANDOFF_TO_IMPLEMENTER — PR #${pr.number} exact head \`${sha}\` has CHANGES_REQUIRED. Continue the existing canonical branch/PR only; resolve the concrete findings and rerun CI. The orchestrator must reconcile the current implementer lease before any edit.`,
    };
  }

  const mergeReady =
    hasExplicitMergeReadySignal(combined) &&
    /\bPASS(?:_WITH_MINOR_FINDINGS)?\b/i.test(combined);
  if (mergeReady) {
    if (eventName === 'issue_comment') return null;
    if (
      eventName === 'pull_request_review' &&
      (!review?.commit_id || review.commit_id !== pr.head?.sha)
    )
      return null;
  }
  if (mergeReady && ciGreen) {
    return {
      kind: 'merge-ready-green',
      target: 'orchestrator',
      sha,
      message: `MERGE_READY_HANDOFF — PR #${pr.number} exact head \`${sha}\` has an independent PASS/MERGE_READY signal and green exact-head CI. Orchestrator: re-check unchanged head, open blocking findings, and merge mechanically if all binding gates remain satisfied.`,
    };
  }

  return null;
}

function assertAllowedTarget(target) {
  if (PAUSED_ACTORS.has(String(target || '').toLowerCase())) {
    throw new Error(`Paused actor cannot be routed by dispatcher: ${target}`);
  }
}

function requestJson({ token, repo, path, method = 'GET', body }) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tabibi-handoff-dispatcher',
      ...(payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
          }
        : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : {});
        } else {
          reject(
            new Error(
              `${method} ${path} -> ${res.statusCode}: ${data.slice(0, 500)}`,
            ),
          );
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchPr(token, repo, number) {
  return requestJson({ token, repo, path: `/pulls/${number}` });
}

async function exactHeadCiGreen(token, repo, sha) {
  const data = await requestJson({
    token,
    repo,
    path: `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`,
  });
  return (data.workflow_runs || []).some(
    (run) =>
      run.name === 'CI' &&
      run.head_sha === sha &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  );
}

async function alreadyPosted(token, repo, issueNumber, marker) {
  const comments = await requestJson({
    token,
    repo,
    path: `/issues/${issueNumber}/comments?per_page=100`,
  });
  return comments.some((comment) =>
    String(comment.body || '').includes(marker),
  );
}

async function postOnce(token, repo, issueNumber, kind, sha, message) {
  const marker = dedupKey(kind, sha);
  if (await alreadyPosted(token, repo, issueNumber, marker)) return false;
  await requestJson({
    token,
    repo,
    path: `/issues/${issueNumber}/comments`,
    method: 'POST',
    body: { body: `${marker}\n${message}` },
  });
  return true;
}

async function postTeamRoomOnce(token, repo, kind, sha, prNumber, message) {
  const marker = dedupKey(`team-${kind}-pr${prNumber}`, sha);
  if (await alreadyPosted(token, repo, TEAM_ROOM_ISSUE, marker)) return false;
  await requestJson({
    token,
    repo,
    path: `/issues/${TEAM_ROOM_ISSUE}/comments`,
    method: 'POST',
    body: {
      body: `${marker}\nHANDOFF_EVENT\nsource: event-driven-dispatcher\npr: #${prNumber}\nhead: ${sha}\n${message}`,
    },
  });
  return true;
}

function getPrNumber(eventName, payload) {
  if (eventName === 'workflow_run') {
    const prs = payload.workflow_run?.pull_requests || [];
    return prs[0]?.number || null;
  }
  if (eventName === 'issue_comment' && !payload.issue?.pull_request) {
    return null;
  }
  return payload.pull_request?.number || payload.issue?.number || null;
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repo || !eventName || !eventPath)
    throw new Error('Missing GitHub Actions environment');

  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const incomingBody = payload.comment?.body || payload.review?.body || '';
  if (incomingBody.includes('<!-- tabibi-handoff:')) return;

  if (
    eventName === 'pull_request' &&
    payload.action === 'closed' &&
    payload.pull_request?.merged
  ) {
    const pr = payload.pull_request;
    const sha = pr.merge_commit_sha || pr.head?.sha || 'unknown';
    await postTeamRoomOnce(
      token,
      repo,
      'post-merge',
      sha,
      pr.number,
      `POST_MERGE_RECONCILE — PR #${pr.number} merged. Reconcile coordination state/retro and launch the next approved bounded work; do not leave healthy actors idle.`,
    );
    return;
  }

  const prNumber = getPrNumber(eventName, payload);
  if (!prNumber) return;

  const pr = await fetchPr(token, repo, prNumber);
  const sha = pr.head?.sha;
  if (!sha) return;

  let ciGreen = false;
  if (eventName === 'pull_request_review') {
    const reviewBody = payload.review?.body || '';
    if (
      hasExplicitMergeReadySignal(reviewBody) &&
      payload.review?.commit_id &&
      payload.review.commit_id === sha
    ) {
      ciGreen = await exactHeadCiGreen(token, repo, sha);
    }
  }

  const decision = decideHandoff({
    eventName,
    pr,
    review: payload.review,
    commentBody: payload.comment?.body || '',
    workflowRun: payload.workflow_run,
    ciGreen,
  });
  if (!decision) return;
  assertAllowedTarget(decision.target);

  const posted = await postOnce(
    token,
    repo,
    pr.number,
    decision.kind,
    decision.sha,
    decision.message,
  );
  if (posted) {
    await postTeamRoomOnce(
      token,
      repo,
      decision.kind,
      decision.sha,
      pr.number,
      decision.message,
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  PAUSED_ACTORS,
  isCopilotLogin,
  dedupKey,
  hasExplicitMergeReadySignal,
  decideHandoff,
  assertAllowedTarget,
  getPrNumber,
};
