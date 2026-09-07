import { execFileSync } from 'node:child_process';

const apiKey = process.env.OPENROUTER_API_KEY;
const repository = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';

if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
if (!repository) throw new Error('GITHUB_REPOSITORY is required');
if (!prNumber) throw new Error('PR_NUMBER is required');

const MAX_DIFF_CHARS = 60000;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
}

const pr = JSON.parse(
  gh(['pr', 'view', prNumber, '--repo', repository, '--json', 'number,title,body,headRefOid,baseRefName,headRefName,url'])
);

let diff = gh(['pr', 'diff', prNumber, '--repo', repository]);
let truncated = false;
if (diff.length > MAX_DIFF_CHARS) {
  diff = diff.slice(0, MAX_DIFF_CHARS);
  truncated = true;
}

const sharedContext = `Repository: ${repository}\nPR: #${pr.number} ${pr.title}\nURL: ${pr.url}\nBase: ${pr.baseRefName}\nHead: ${pr.headRefName}\nExact head SHA: ${pr.headRefOid}\nDiff truncated: ${truncated ? 'yes' : 'no'}\n\nPR description:\n${pr.body || '(none)'}\n\nDIFF:\n${diff}`;

const specialists = [
  {
    id: 'NEMOTRON',
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    role: 'Review architecture, security boundaries, authorization/tenancy, concurrency, failure modes, and operational invariants. Focus only on concrete issues supported by the diff.',
  },
  {
    id: 'GLM',
    model: 'z-ai/glm-5.3',
    role: 'Review code correctness, migrations, state transitions, data-flow/API bugs, invariants, error handling, and test adequacy. Prefer reproducible defects over style comments.',
  },
  {
    id: 'MINIMAX',
    model: 'minimax/minimax-m3',
    role: 'Review user-facing behavior, accessibility, UI/API ergonomics, operational workflows, edge cases, and regressions that affect clinic staff or waiting-room users.',
  },
  {
    id: 'GEMMA',
    model: 'google/gemma-3-27b-it',
    role: 'Review Arabic/French behavior, RTL/LTR correctness, localization, privacy-safe public copy, public API contracts, and accidental identity/data leakage.',
  },
];

async function ask(model, system, user, maxTokens = 1100) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `${serverUrl}/${repository}`,
        'X-Title': 'Tabibi OpenRouter Review Council',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${text.slice(0, 500)}`);
    }
    const json = await response.json();
    return json?.choices?.[0]?.message?.content?.trim() || '(empty response)';
  } finally {
    clearTimeout(timer);
  }
}

const systemBase = `You are an independent advisory reviewer for the Tabibi software project. Do not expose chain-of-thought. Return only concise findings and verification-oriented reasoning. Never claim to have run tests, inspected files outside the supplied context, or verified runtime behavior unless the supplied evidence proves it. Use severity BLOCKER/MAJOR/MINOR/NOTE. For each actionable issue include: ID, severity, affected file/area, why it matters, and a specific fix/test. If no material issue exists, say NO_MATERIAL_FINDING. This is advisory only and not merge authority.`;

const specialistResults = await Promise.all(
  specialists.map(async (s) => {
    try {
      const text = await ask(s.model, `${systemBase}\n\nSpecialist mandate: ${s.role}`, sharedContext);
      return { ...s, ok: true, text };
    } catch (error) {
      return { ...s, ok: false, text: `UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}` };
    }
  })
);

const successful = specialistResults.filter((r) => r.ok);
let synthesis = 'Judge unavailable: fewer than two specialist responses succeeded.';

if (successful.length >= 2) {
  const councilEvidence = successful
    .map((r) => `### ${r.id} (${r.model})\n${r.text}`)
    .join('\n\n');
  try {
    synthesis = await ask(
      'deepseek/deepseek-v4-flash',
      `${systemBase}\n\nYou are the council synthesizer. Reconcile specialist outputs without inventing evidence. Deduplicate findings. Explicitly separate CONSENSUS findings (2+ specialists materially agree), SINGLE-MODEL findings, and DISAGREEMENTS. Give an overall advisory verdict: ADVISORY_PASS, ADVISORY_PASS_WITH_FINDINGS, or ADVISORY_CHANGES_RECOMMENDED. Do not emit PASS/MERGE_READY.`,
      `PR exact head: ${pr.headRefOid}\nDiff truncated: ${truncated ? 'yes' : 'no'}\n\nSPECIALIST OUTPUTS:\n${councilEvidence}`,
      1500
    );
  } catch (error) {
    synthesis = `Judge unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const specialistMarkdown = specialistResults
  .map((r) => `### ${r.id} — \`${r.model}\`\n${r.text}`)
  .join('\n\n');

const body = `OPENROUTER_COUNCIL_ADVISORY\n\n> **Advisory only — NOT a gating review and NOT merge authority.**\n> Exact PR head reviewed: \`${pr.headRefOid}\`\n> Diff truncated before model transmission: **${truncated ? 'yes' : 'no'}**\n\n## Council synthesis — DeepSeek V4 Flash\n${synthesis}\n\n## Specialist reviews\n${specialistMarkdown}\n\n---\nCouncil configuration: Nemotron 3 Ultra (architecture/security/concurrency), GLM 5.3 (correctness/migrations), MiniMax M3 (UX/operations), Gemma 3 27B (Arabic/French/RTL/privacy), DeepSeek V4 Flash (synthesis).`;

const tmp = '/tmp/openrouter-council-comment.md';
await import('node:fs').then(({ writeFileSync }) => writeFileSync(tmp, body));
gh(['pr', 'comment', prNumber, '--repo', repository, '--body-file', tmp]);

console.log(`OpenRouter council posted advisory review for PR #${prNumber} at ${pr.headRefOid}`);
