import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as archivePost } from '@/app/api/patient/dependents/[dependentId]/archive/route';
import {
  GET as itemGet,
  PATCH as itemPatch,
} from '@/app/api/patient/dependents/[dependentId]/route';
import {
  GET as listGet,
  POST as createPost,
} from '@/app/api/patient/dependents/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import { POST as logoutPost } from '@/app/api/patient/session/logout/route';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { closePool, getPool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P1-01 slice 7: account-owned dependent routes behind the patient session.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'patient-dependents-secret-at-least-32-characters';
const PASS = 'correct horse battery';
const A = 'leila.patient@example.test';
const B = 'karim.patient@example.test';
const PCOOKIE = 'tabibi_patient_session';
const BASE = 'http://localhost/api/patient/dependents';

const tokenOf = (res: Response) =>
  /tabibi_patient_session=([^;]+)/.exec(
    res.headers.get('set-cookie') ?? '',
  )?.[1] as string;
const login = async (email: string) =>
  `${PCOOKIE}=${tokenOf(
    await signInPost(
      new Request('http://localhost/api/patient/session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ email, password: PASS }),
      }),
    ),
  )}`;
function req(
  method: string,
  url: string,
  cookie: string | null,
  body?: unknown,
  origin: string | null = 'http://localhost',
) {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (origin !== null) headers.set('origin', origin);
  if (cookie) headers.set('cookie', cookie);
  return new Request(url, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ dependentId: id }) });
const create = (cookie: string | null, body: unknown, origin?: string | null) =>
  createPost(req('POST', BASE, cookie, body, origin));
const list = (cookie: string | null, q = '') =>
  listGet(req('GET', BASE + q, cookie));
const created = async (cookie: string, displayName: string) =>
  (await (await create(cookie, { displayName })).json()).dependent as {
    id: string;
    displayName: string;
    status: string;
  };
const rows = async () =>
  (await pool.query('SELECT id, display_name, status FROM patient_dependents'))
    .rows;

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE patient_dependents, patient_credentials, users, staff_sign_in_rate_limit_buckets CASCADE`,
  );
  for (const [email, name] of [
    [A, 'Leila'],
    [B, 'Karim'],
  ] as const)
    await registerPatientAccount(getPool(), {
      email,
      displayName: name,
      password: PASS,
    });
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('patient dependent routes', () => {
  it('creates, lists, reads, renames and archives for the signed-in owner only', async () => {
    const a = await login(A);
    const b = await login(B);
    const res = await create(a, { displayName: '  ليلى بن علي ' });
    expect(res.status).toBe(201);
    const dep = (await res.json()).dependent;
    expect(dep).toMatchObject({ displayName: 'ليلى بن علي', status: 'active' });
    expect(Object.keys(dep).sort()).toEqual([
      'archivedAt',
      'createdAt',
      'displayName',
      'id',
      'status',
      'updatedAt',
    ]);
    expect((await (await list(a)).json()).dependents).toHaveLength(1);
    expect((await (await list(b)).json()).dependents).toEqual([]);
    expect(
      (await itemGet(req('GET', `${BASE}/${dep.id}`, a), ctx(dep.id))).status,
    ).toBe(200);
    const renamed = await itemPatch(
      req('PATCH', `${BASE}/${dep.id}`, a, { displayName: 'Élodie' }),
      ctx(dep.id),
    );
    expect((await renamed.json()).dependent.displayName).toBe('Élodie');
    const arch = await archivePost(
      req('POST', `${BASE}/${dep.id}/archive`, a),
      ctx(dep.id),
    );
    expect((await arch.json()).dependent.status).toBe('archived');
    // Idempotent, hidden from the default list, visible with includeArchived.
    expect(
      (
        await archivePost(
          req('POST', `${BASE}/${dep.id}/archive`, a),
          ctx(dep.id),
        )
      ).status,
    ).toBe(200);
    expect((await (await list(a)).json()).dependents).toEqual([]);
    expect(
      (await (await list(a, '?includeArchived=true')).json()).dependents,
    ).toHaveLength(1);
    // An archived dependent cannot be renamed.
    expect(
      (
        await itemPatch(
          req('PATCH', `${BASE}/${dep.id}`, a, { displayName: 'X' }),
          ctx(dep.id),
        )
      ).status,
    ).toBe(404);
  });

  it('answers 404 for another account, unknown and malformed ids alike (IDOR)', async () => {
    const a = await login(A);
    const b = await login(B);
    const dep = await created(a, 'Mine');
    const before = await rows();
    const probes = [dep.id, randomUUID(), 'not-a-uuid'];
    const bodies: unknown[] = [];
    for (const id of probes) {
      const read = await itemGet(req('GET', `${BASE}/${id}`, b), ctx(id));
      const patch = await itemPatch(
        req('PATCH', `${BASE}/${id}`, b, { displayName: 'Stolen' }),
        ctx(id),
      );
      const arch = await archivePost(
        req('POST', `${BASE}/${id}/archive`, b),
        ctx(id),
      );
      for (const r of [read, patch, arch]) {
        expect(r.status).toBe(404);
        const j = await r.json();
        delete j.requestId;
        bodies.push(j);
      }
    }
    expect(new Set(bodies.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(await rows()).toEqual(before);
    // Positive control: the real owner reaches the same dependent.
    expect(
      (await itemGet(req('GET', `${BASE}/${dep.id}`, a), ctx(dep.id))).status,
    ).toBe(200);
  });

  it('ignores a client-supplied owner and refuses unknown body fields', async () => {
    const a = await login(A);
    const ownerB = (
      await pool.query(`SELECT id FROM users WHERE auth_subject=$1`, [
        `patient:${B}`,
      ])
    ).rows[0].id;
    for (const extra of [
      { ownerUserId: ownerB },
      { owner_user_id: ownerB },
      { status: 'archived' },
    ])
      expect((await create(a, { displayName: 'Kid', ...extra })).status).toBe(
        400,
      );
    expect(await rows()).toEqual([]);
    expect((await list(a, '?ownerUserId=' + ownerB)).status).toBe(400);
    expect((await create(a, { displayName: 'Kid' })).status).toBe(201);
    const [row] = (
      await pool.query(`SELECT owner_user_id FROM patient_dependents`)
    ).rows;
    expect(row.owner_user_id).not.toBe(ownerB);
  });

  it('requires a patient session: missing, garbage, staff token and logged-out all 401', async () => {
    const a = await login(A);
    const dep = await created(a, 'Mine');
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES(gen_random_uuid(),'someone@example.test','Staff')`,
    );
    const staff = await createStaffSessionToken(
      'someone@example.test',
      new Date(Date.now() + 3600_000),
    );
    const bad = [
      null,
      `${PCOOKIE}=garbage`,
      `${PCOOKIE}=${staff}`,
      `tabibi_staff_session=${staff}`,
    ];
    for (const c of bad) {
      expect((await list(c)).status).toBe(401);
      expect((await create(c, { displayName: 'X' })).status).toBe(401);
      expect(
        (await itemGet(req('GET', `${BASE}/${dep.id}`, c), ctx(dep.id))).status,
      ).toBe(401);
      expect(
        (
          await itemPatch(
            req('PATCH', `${BASE}/${dep.id}`, c, { displayName: 'X' }),
            ctx(dep.id),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await archivePost(
            req('POST', `${BASE}/${dep.id}/archive`, c),
            ctx(dep.id),
          )
        ).status,
      ).toBe(401);
    }
    expect((await rows()).length).toBe(1);
    await logoutPost(
      req('POST', 'http://localhost/api/patient/session/logout', a),
    );
    expect((await list(a)).status).toBe(401);
    // Positive control: a fresh session works.
    expect((await list(await login(A))).status).toBe(200);
  });

  it('refuses cross-origin and missing-origin mutations without writing', async () => {
    const a = await login(A);
    const dep = await created(a, 'Mine');
    for (const origin of ['http://evil.example', null]) {
      expect((await create(a, { displayName: 'X' }, origin)).status).toBe(403);
      expect(
        (
          await itemPatch(
            req('PATCH', `${BASE}/${dep.id}`, a, { displayName: 'X' }, origin),
            ctx(dep.id),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await archivePost(
            req('POST', `${BASE}/${dep.id}/archive`, a, undefined, origin),
            ctx(dep.id),
          )
        ).status,
      ).toBe(403);
    }
    expect(await rows()).toEqual([
      { id: dep.id, display_name: 'Mine', status: 'active' },
    ]);
  });

  it('rejects invalid names, malformed and oversized bodies with 400', async () => {
    const a = await login(A);
    for (const body of [
      {},
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'bad\u0000name' },
      { displayName: 'x'.repeat(161) },
      { displayName: 5 },
      '{not json',
      JSON.stringify({ displayName: 'x', pad: 'y'.repeat(4096) }),
    ])
      expect((await create(a, body)).status).toBe(400);
    expect(await rows()).toEqual([]);
    expect((await create(a, { displayName: 'ok' })).status).toBe(201);
  });

  it('measures name length in NFC code points, not raw UTF-16 units', async () => {
    const a = await login(A);
    // 110 decomposed e+acute = 220 raw units but 110 code points after NFC.
    const decomposed = 'e\u0301'.repeat(110);
    const made = await create(a, { displayName: decomposed });
    expect(made.status).toBe(201);
    const dep = (await made.json()).dependent;
    expect(dep.displayName).toBe('\u00e9'.repeat(110));
    const renamed = await itemPatch(
      req('PATCH', `${BASE}/${dep.id}`, a, { displayName: decomposed }),
      ctx(dep.id),
    );
    expect(renamed.status).toBe(200);
    // Positive control: a genuinely over-long name is still refused.
    expect(
      (await create(a, { displayName: '\u00e9'.repeat(161) })).status,
    ).toBe(400);
    expect(
      (await create(a, { displayName: '\u00e9'.repeat(160) })).status,
    ).toBe(201);
  });

  it('rate limits mutations per account with 429 and Retry-After', async () => {
    const a = await login(A);
    const b = await login(B);
    for (let i = 0; i < 30; i++)
      expect((await create(a, { displayName: `Kid ${i}` })).status).toBe(201);
    const limited = await create(a, { displayName: 'one too many' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await rows()).toHaveLength(30);
    // Another account is unaffected.
    expect((await create(b, { displayName: 'Fine' })).status).toBe(201);
  });
});
