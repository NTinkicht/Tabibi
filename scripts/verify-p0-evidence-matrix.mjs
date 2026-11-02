#!/usr/bin/env node
// Checks that every file path and test title cited in docs/verification/p0-evidence-matrix.md
// still exists. Evidence lines look like:
//   - [COVERED|PARTIAL|MISSING] criterion | src: a.ts, b.ts | test: tests/x.test.ts :: "title prefix" | pr: #1
// Deterministic, offline, read-only. Exit 1 on any problem.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERDICTS = new Set(['COVERED', 'PARTIAL', 'MISSING']);
const ROWS = Array.from(
  { length: 15 },
  (_, i) => `TAB-P0-${String(i + 1).padStart(2, '0')}`,
);

export function checkMatrix(
  text,
  root,
  fileExists = existsSync,
  readText = (p) => readFileSync(p, 'utf8'),
) {
  const errors = [];
  const seenRows = new Set();
  const rowEvidence = new Map();
  let row = null;
  for (const [index, line] of text.split('\n').entries()) {
    const at = `line ${index + 1}`;
    const heading = /^## (TAB-P0-\d\d)\b/.exec(line);
    if (heading) {
      row = heading[1];
      seenRows.add(row);
      rowEvidence.set(row, 0);
      continue;
    }
    const evidence = /^- \[([A-Z]+)\] (.*)$/.exec(line);
    if (!evidence) continue;
    if (!row) errors.push(`${at}: evidence outside a TAB-P0 section`);
    else rowEvidence.set(row, (rowEvidence.get(row) ?? 0) + 1);
    const [verdict, rest] = [evidence[1], evidence[2]];
    if (!VERDICTS.has(verdict))
      errors.push(`${at}: unknown verdict ${verdict}`);
    const fields = Object.fromEntries(
      rest
        .split(' | ')
        .slice(1)
        .map((part) => {
          const sep = part.indexOf(': ');
          return sep < 0
            ? [part, '']
            : [part.slice(0, sep), part.slice(sep + 2)];
        }),
    );
    if (verdict === 'COVERED' && !(fields.src && fields.test)) {
      errors.push(`${at}: COVERED needs both src and test citations`);
    }
    for (const src of (fields.src ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!fileExists(resolve(root, src)))
        errors.push(`${at}: missing source path ${src}`);
    }
    for (const test of (fields.test ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const m = /^(\S+) :: "([^"]+)"$/.exec(test);
      if (!m) {
        errors.push(`${at}: malformed test citation ${test}`);
        continue;
      }
      const path = resolve(root, m[1]);
      if (!fileExists(path)) errors.push(`${at}: missing test file ${m[1]}`);
      else if (!readText(path).includes(m[2]))
        errors.push(`${at}: test title not found in ${m[1]}: ${m[2]}`);
    }
  }
  for (const id of ROWS) {
    if (!seenRows.has(id)) errors.push(`missing section for ${id}`);
    else if (!rowEvidence.get(id)) errors.push(`${id} has no evidence lines`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkMatrix(
    readFileSync(
      resolve(root, 'docs/verification/p0-evidence-matrix.md'),
      'utf8',
    ),
    root,
  );
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('p0 evidence matrix: all cited paths and test titles exist');
}
