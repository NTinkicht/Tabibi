#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const registryPath = path.join(process.cwd(), 'coordination', 'ACTOR_REGISTRY.json');

function parseCsvFlag(args, name) {
  const prefix = `${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  if (!value) return new Set();
  return new Set(
    value
      .slice(prefix.length)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function fail(message, details = {}) {
  process.stdout.write(`${JSON.stringify({ selected: null, error: message, ...details })}\n`);
  process.exit(2);
}

const [, , capability, ...flags] = process.argv;
if (!capability) {
  fail('Usage: node scripts/actor-router.mjs <capability> [--authors=a,b] [--unavailable=a,b]');
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const route = registry.routing?.[capability];
if (!Array.isArray(route)) {
  fail(`Unknown capability: ${capability}`);
}

const authors = parseCsvFlag(flags, '--authors');
const unavailable = parseCsvFlag(flags, '--unavailable');
const actors = new Map(registry.actors.map((actor) => [actor.id, actor]));
const considered = [];

for (const id of route) {
  const actor = actors.get(id);
  let reason = null;

  if (!actor || !actor.active) reason = 'inactive_or_missing';
  else if (actor.paid_fallback !== false) reason = 'paid_fallback_not_fail_closed';
  else if (!actor.capabilities.includes(capability)) reason = 'capability_not_declared';
  else if (unavailable.has(id)) reason = 'currently_unavailable';
  else if (capability === 'review' && authors.has(id)) reason = 'material_author_cannot_self_gate';

  considered.push({ id, eligible: reason === null, reason });
  if (reason === null) {
    process.stdout.write(
      `${JSON.stringify({ selected: id, capability, considered, financial_mode: registry.financial_mode })}\n`,
    );
    process.exit(0);
  }
}

fail('No eligible actor for requested capability', { capability, considered });
