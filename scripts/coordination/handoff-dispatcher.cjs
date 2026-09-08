/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const fs = require('node:fs');
const https = require('node:https');

const PAUSED_ACTORS = new Set(['gemini', 'gemini_agent', 'gemini_chat']);
const TEAM_ROOM_ISSUE = 21;
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const PASSING_VERDICTS = new Set(['PASS', 'PASS_WITH_MINOR_FINDINGS']);
const FINDING_SEVERITIES = new Set(['BLOCKER', 'MAJOR', 'MINOR', 'NOTE']);

function isCopilotLogin(login = '') {
  return /^(copilot|copilot-swe-agent\[bot\])$/i.test(login);
}

function dedupKey(kind, sha = 'none') {
  return `<!-- tabibi-handoff:${kind}:${sha} -->`;
}

function parseKeyValueArtifact(text, marker, allowedFields) {
  const lines = String(text).split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((line) => line.trim() !== '');
  if (firstNonEmpty < 0 || lines[firstNonEmpty].trim() !== marker) return null;

  const fields = {};
  for (const rawLine of lines.slice(firstNonEmpty + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('```') || line.startsWith('>')) return null;
    const match = /^([a-z_]+):\s*(.+)$/i.exec(line);
    if (!match) return null;
    const key = match[1].toLowerCase();
    if (!allowedFields.has(key) || Object.hasOwn(fields, key)) return null;
    fields[key] = match[2].trim();
  }
  return fields;
}

function parseSpecialistReview(text = '') {
  const lines = String(text).split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((line) => line.trim() !== '');
  if (
    firstNonEmpty < 0 ||
    lines[firstNonEmpty].trim() !== 'SPECIALIST_REVIEW'
  ) {
    return null;
  }

  const allowedFields = new Set([
    'actor',
    'overlay',
    'pr',
    'exact_sha',
    'verdict',
    'merge_ready',
  ]);
  const fields = {};
  const findings = [];
  let inFindings = false;

  for (const rawLine of lines.slice(firstNonEmpty + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('```') || line.startsWith('>')) return null;

    if (line === 'findings:') {
      if (inFindings) return null;
      inFindings = true;
      continue;
    }

    if (inFindings) {
      const findingMatch = /^-\s*(BLOCKER|MAJOR|MINOR|NOTE):\s*(.+)$/i.exec(
        line,
      );
      if (!findingMatch) return null;
      const severity = findingMatch[1].toUpperCase();
      if (!FINDING_SEVERITIES.has(severity)) return null;
      findings.push({ severity, text: findingMatch[2].trim() });
      continue;
    }

    const match = /^([a-z_]+):\s*(.+)$/i.exec(line);
    if (!match) return null;
    const key = match[1].toLowerCase();
    if (!allowedFields.has(key) || Object.hasOwn(fields, key)) return null;
    fields[key] = match[2].trim();
  }

  if (!fields.actor || !fields.overlay || !fields.pr || !fields.exact_sha) {
    return null;
  }
  if (!fields.verdict || !fields.merge_ready || !inFindings) return null;
  return { ...fields, findings };
}

function parseGateReconciliation(text = '') {
  const fields = parseKeyValueArtifact(
    text,
    'GATE_RECONCILIATION',
    new Set([
      'pr',
      'exact_sha',
      'gate_actor',
      'reviewer_login',
      'overlay',
      'material_authorship',
      'open_blockers',
      'open_majors',
      'status',
    ]),
  );
  if (!fields) return null;
  return fields;
}

function reconcileGateEligibility({
  comments = [],
  prNumber,
  sha,
  artifact,
  reviewLogin,
}) {
  if (!artifact || artifact.overlay !== 'code-reviewer') return null;

  for (const comment of comments) {
    if (
      !TRUSTED_ASSOCIATIONS.has(
        String(comment.author_association || '').toUpperCase(),
      )
    ) {
      continue;
    }
    const record = parseGateReconciliation(comment.body || '');
    if (!record) continue;
    if (Number(record.pr) !== Number(prNumber)) continue;
    if (record.exact_sha !== sha) continue;
    if (record.gate_actor !== artifact.actor) continue;
    if (record.reviewer_login !== reviewLogin) continue;
    if (record.overlay !== 'code-reviewer') continue;
    if (record.material_authorship !== 'independent') continue;
    if (record.status !== 'eligible') continue;
    if (
      Number(record.open_blockers) !== 0 ||
      Number(record.open_majors) !== 0
    ) {
      continue;
    }
    return record;
  }
  return null;
}

function hasBlockingFindings(artifact) {
  return (artifact?.findings || []).some((finding) =>
    ['BLOCKER', 'MAJOR'].includes(finding.severity),
  );
}

function hasExplicitMergeReadySignal(text = '', expectedSha, expectedPrNumber) {
  const artifact = parseSpecialistReview(text);
  if (!artifact) return false;
  const verdict = String(artifact.verdict || '').toUpperCase();
  if (!PASSING_VERDICTS.has(verdict)) return false;
  if (artifact.overlay !== 'code-reviewer') return false;
  if (String(artifact.merge_ready || '').toLowerCase() !== 'yes') return false;
  if (hasBlockingFindings(artifact)) return false;
  if (expectedSha && artifact.exact_sha !== expectedSha) return false;
  if (expectedPrNumber && Number(artifact.pr) !== Number(expectedPrNumber)) {
    return false;
  }
  return true;
}

function decideHandoff({
  eventName,
  pr,
  review,
  commentBody = '',
  workflowRun,
  ciGreen = false,
  gateReconciliation = null,
}) {
  if (!pr) return null;
  const sha = pr.head?.sha || workflowRun?.head_sha || 'unknown';
  const author = pr.user?.login || '';

  if (eventName === 'workflow_run') {
    if (
      workflowRun?.status !== 'completed' ||
      workflowRun?.conclusion !== 'success'
    ) {
      return null;
    }
    if (
      workflowRun.head_sha &&
      pr.head?.sha &&
      workflowRun.head_sha !== pr.head.sha
    ) {
      return null;
    }
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

  const artifact = parseSpecialistReview(reviewBody);
  const mergeReady = hasExplicitMergeReadySignal(reviewBody, sha, pr.number);
  if (mergeReady) {
    if (eventName !== 'pull_request_review') return null;
    if (reviewState !== 'approved') return null;
    if (!review?.commit_id || review.commit_id !== pr.head?.sha) return null;
    if (!gateReconciliation) return null;
    if (gateReconciliation.gate_actor !== artifact.actor) return null;
    if (gateReconciliation.exact_sha !== sha) return null;
  }

  if (mergeReady && ciGreen) {
    return {
      kind: 'merge-ready-green',
      target: 'orchestrator',
      sha,
      message: `MERGE_READY_HANDOFF — PR #${pr.number} exact head \`${sha}\` has an approved, independently reconciled code-reviewer PASS gate, zero known BLOCKER/MAJOR findings, and green exact-head CI. Orchestrator: re-check unchanged head before mechanical merge.`,
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

async function fetchIssueComments(token, repo, number) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await requestJson({
      token,
      repo,
      path: `/issues/${number}/comments?per_page=100&page=${page}`,
    });
    const items = Array.isArray(batch) ? batch : [];
    comments.push(...items);
    if (items.length < 100) break;
  }
  return comments;
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
  const comments = await fetchIssueComments(token, repo, issueNumber);
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
  if (eventName === 'issue_comment' && !payload.issue?.pull_request)
    return null;
  return payload.pull_request?.number || payload.issue?.number || null;
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repo || !eventName || !eventPath) {
    throw new Error('Missing GitHub Actions environment');
  }

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
  let gateReconciliation = null;
  if (eventName === 'pull_request_review') {
    const reviewBody = payload.review?.body || '';
    const artifact = parseSpecialistReview(reviewBody);
    if (
      artifact &&
      hasExplicitMergeReadySignal(reviewBody, sha, pr.number) &&
      String(payload.review?.state || '').toLowerCase() === 'approved' &&
      payload.review?.commit_id === sha
    ) {
      const comments = await fetchIssueComments(token, repo, pr.number);
      gateReconciliation = reconcileGateEligibility({
        comments,
        prNumber: pr.number,
        sha,
        artifact,
        reviewLogin: payload.review?.user?.login || '',
      });
      if (gateReconciliation) {
        ciGreen = await exactHeadCiGreen(token, repo, sha);
      }
    }
  }

  const decision = decideHandoff({
    eventName,
    pr,
    review: payload.review,
    commentBody: payload.comment?.body || '',
    workflowRun: payload.workflow_run,
    ciGreen,
    gateReconciliation,
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
  TRUSTED_ASSOCIATIONS,
  isCopilotLogin,
  dedupKey,
  parseSpecialistReview,
  parseGateReconciliation,
  reconcileGateEligibility,
  hasBlockingFindings,
  hasExplicitMergeReadySignal,
  decideHandoff,
  assertAllowedTarget,
  getPrNumber,
};
