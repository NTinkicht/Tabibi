import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import { bootstrapFirstClinicAdmin } from '@/modules/identity/bootstrap-admin';
import { verifyStaffPassword } from '@/modules/identity/staff-credentials';
import {
  InviteConflictError,
  InviteInputError,
  InviteRejectedError,
  StaffInviteService,
} from '@/modules/identity/staff-invites';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const service = new StaffInviteService(pool);
const clinicA = randomUUID();
const clinicB = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();
const receptionistA = randomUUID();
const GOOD = 'correct horse battery';
const scopeA = { clinicId: clinicA, actorUserId: adminA };

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE staff_invites, staff_credentials, audit_events, clinic_memberships, users, clinics CASCADE',
  );
  for (const [id, key] of [
    [clinicA, 'invite-a'],
    [clinicB, 'invite-b'],
  ] as const) {
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,$2,$2)`,
      [id, key],
    );
  }
  for (const [id, subject, clinic, role] of [
    [adminA, 'admin-a@x.example', clinicA, 'clinic_admin'],
    [adminB, 'admin-b@x.example', clinicB, 'clinic_admin'],
    [receptionistA, 'rec-a@x.example', clinicA, 'receptionist'],
  ] as const) {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,$2,'U')`,
      [id, subject],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES ($1,$2,$3)`,
      [clinic, id, role],
    );
  }
});

const invite = (email = 'new@x.example', role = 'receptionist') =>
  service.create(scopeA, { email, role });

describe('staff invites (#727)', () => {
  it('stores only a SHA-256 verifier and never the token', async () => {
    const { token, inviteId } = await invite();
    const secret = token.split('.')[1]!;
    const row = await pool.query<{ token_verifier: Buffer }>(
      'SELECT token_verifier FROM staff_invites WHERE id=$1',
      [inviteId],
    );
    expect(row.rows[0]!.token_verifier).toHaveLength(32);
    expect(row.rows[0]!.token_verifier.toString('utf8')).not.toContain(secret);
    const all = JSON.stringify(
      (await pool.query('SELECT * FROM staff_invites')).rows,
    );
    expect(all).not.toContain(secret);
  });

  it('only a clinic_admin of that clinic can create or revoke; cross-clinic is denied', async () => {
    await expect(
      service.create(
        { clinicId: clinicA, actorUserId: receptionistA },
        { email: 'a@x.example', role: 'doctor' },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      service.create(
        { clinicId: clinicA, actorUserId: adminB },
        { email: 'a@x.example', role: 'doctor' },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const { inviteId } = await invite();
    await expect(
      service.revoke({ clinicId: clinicB, actorUserId: adminB }, inviteId),
    ).rejects.toBeInstanceOf(InviteRejectedError);
    await expect(
      service.revoke(
        { clinicId: clinicA, actorUserId: receptionistA },
        inviteId,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const row = await pool.query(
      'SELECT revoked_at FROM staff_invites WHERE id=$1',
      [inviteId],
    );
    expect(row.rows[0].revoked_at).toBeNull();
  });

  it('limits grantable roles: clinic_admin and unknown roles are refused', async () => {
    await expect(invite('a@x.example', 'clinic_admin')).rejects.toBeInstanceOf(
      InviteInputError,
    );
    await expect(invite('a@x.example', 'owner')).rejects.toBeInstanceOf(
      InviteInputError,
    );
    await expect(invite('not-an-email')).rejects.toBeInstanceOf(
      InviteInputError,
    );
    await expect(
      service.create(scopeA, {
        email: 'a@x.example',
        role: 'doctor',
        ttlSeconds: 10 ** 9,
      }),
    ).rejects.toBeInstanceOf(InviteInputError);
  });

  it('refuses a duplicate open invite for the same email and clinic, and allows it after revoke', async () => {
    const first = await invite('Dup@X.example');
    await expect(invite('dup@x.example')).rejects.toBeInstanceOf(
      InviteConflictError,
    );
    await service.revoke(scopeA, first.inviteId);
    await expect(invite('dup@x.example')).resolves.toBeDefined();
  });

  it('accept creates user, password and membership atomically and audits without secrets', async () => {
    const { token } = await invite('new@x.example', 'doctor');
    const out = await service.accept(token, {
      displayName: 'New Doc',
      password: GOOD,
    });
    expect(out.role).toBe('doctor');
    const m = await pool.query(
      'SELECT role FROM clinic_memberships WHERE clinic_id=$1 AND user_id=$2',
      [clinicA, out.userId],
    );
    expect(m.rows[0].role).toBe('doctor');
    expect(await verifyStaffPassword(pool, 'new@x.example', GOOD)).toEqual({
      ok: true,
      userId: out.userId,
    });
    const audits = await pool.query(
      `SELECT action, metadata FROM audit_events WHERE entity_type='staff_invite' ORDER BY id`,
    );
    expect(audits.rows.map((r) => r.action)).toEqual([
      'invite_created',
      'invite_accepted',
    ]);
    const dump = JSON.stringify(audits.rows);
    expect(dump).not.toContain(token.split('.')[1]);
    expect(dump).not.toContain(GOOD);
  });

  it('refuses expired, revoked, used, malformed and wrong-secret tokens with one generic error', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const expired = await service.create(
      scopeA,
      { email: 'e@x.example', role: 'doctor', ttlSeconds: 60 },
      t0,
    );
    const revoked = await invite('r@x.example');
    await service.revoke(scopeA, revoked.inviteId);
    const used = await invite('u@x.example');
    await service.accept(used.token, { displayName: 'U', password: GOOD });
    const live = await invite('w@x.example');
    const wrong = `${live.inviteId}.${'A'.repeat(43)}`;
    const messages = new Set<string>();
    for (const [tok, now] of [
      [expired.token, new Date(t0.getTime() + 61_000)],
      [revoked.token, new Date()],
      [used.token, new Date()],
      [wrong, new Date()],
      ['garbage', new Date()],
      [`${randomUUID()}.${'A'.repeat(43)}`, new Date()],
    ] as const) {
      const error = await service
        .accept(tok, { displayName: 'X', password: GOOD }, now)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InviteRejectedError);
      messages.add((error as Error).message);
    }
    expect(messages.size).toBe(1);
    await expect(
      service.accept(live.token, { displayName: 'W', password: GOOD }),
    ).resolves.toBeDefined();
  });

  it('a weak password leaves the invite usable and creates nothing', async () => {
    const { token } = await invite('weak@x.example');
    await expect(
      service.accept(token, { displayName: 'W', password: 'short' }),
    ).rejects.toThrow(/password/i);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM users WHERE auth_subject='weak@x.example'`,
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      service.accept(token, { displayName: 'W', password: GOOD }),
    ).resolves.toBeDefined();
  });

  it('a concurrent double-accept has exactly one winner', async () => {
    const { token } = await invite('race@x.example');
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        service.accept(token, { displayName: 'R', password: GOOD }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM users WHERE auth_subject='race@x.example'`,
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM clinic_memberships m JOIN users u ON u.id=m.user_id WHERE u.auth_subject='race@x.example'`,
        )
      ).rowCount,
    ).toBe(1);
  });

  it('never overwrites an existing account password and never changes an existing membership', async () => {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,'old@x.example','Old')`,
      [randomUUID()],
    );
    const oldId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE auth_subject='old@x.example'`,
      )
    ).rows[0]!.id;
    const { setStaffPassword } = await import(
      '@/modules/identity/staff-credentials'
    );
    await setStaffPassword(pool, oldId, 'the original password');
    const { token } = await invite('old@x.example');
    await service.accept(token, {
      displayName: 'Old',
      password: 'an attacker chosen pass',
    });
    expect(
      (
        await verifyStaffPassword(
          pool,
          'old@x.example',
          'the original password',
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await verifyStaffPassword(
          pool,
          'old@x.example',
          'an attacker chosen pass',
        )
      ).ok,
    ).toBe(false);
    // already a member (receptionist) -> an admin-role-changing invite is rejected, role unchanged
    const second = await service.create(scopeA, {
      email: 'rec-a@x.example',
      role: 'doctor',
    });
    await expect(
      service.accept(second.token, { displayName: 'R', password: GOOD }),
    ).rejects.toBeInstanceOf(InviteRejectedError);
    const role = await pool.query(
      `SELECT role FROM clinic_memberships WHERE user_id=$1`,
      [receptionistA],
    );
    expect(role.rows[0].role).toBe('receptionist');
  });
});

describe('bootstrap first clinic_admin (#727)', () => {
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE audit_events, clinic_memberships, staff_credentials, users CASCADE',
    );
  });

  it('creates once, then is a no-op; concurrent runs create exactly one admin', async () => {
    const input = {
      clinicId: clinicA,
      email: 'first@x.example',
      displayName: 'First',
      password: GOOD,
    };
    const results = await Promise.all([
      bootstrapFirstClinicAdmin(pool, input),
      bootstrapFirstClinicAdmin(pool, { ...input, email: 'second@x.example' }),
      bootstrapFirstClinicAdmin(pool, { ...input, email: 'third@x.example' }),
    ]);
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'already_exists')).toHaveLength(
      2,
    );
    expect(
      (
        await pool.query(
          `SELECT 1 FROM clinic_memberships WHERE clinic_id=$1 AND role='clinic_admin'`,
          [clinicA],
        )
      ).rowCount,
    ).toBe(1);
    const audit = await pool.query(
      `SELECT action FROM audit_events WHERE clinic_id=$1`,
      [clinicA],
    );
    expect(audit.rows).toEqual([{ action: 'bootstrap_clinic_admin' }]);
  });

  it('refuses weak passwords and existing accounts, creating nothing', async () => {
    await expect(
      bootstrapFirstClinicAdmin(pool, {
        clinicId: clinicA,
        email: 'w@x.example',
        displayName: 'W',
        password: 'short',
      }),
    ).rejects.toThrow(/password/i);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,'taken@x.example','T')`,
      [randomUUID()],
    );
    await expect(
      bootstrapFirstClinicAdmin(pool, {
        clinicId: clinicA,
        email: 'taken@x.example',
        displayName: 'T',
        password: GOOD,
      }),
    ).rejects.toThrow(/already exists/);
    expect(
      (await pool.query('SELECT 1 FROM clinic_memberships')).rowCount,
    ).toBe(0);
  });

  it('the CLI reads the password from stdin, never echoes it, and a second run is a no-op', () => {
    const run = (password: string) =>
      spawnSync(
        'npx',
        [
          'tsx',
          'scripts/db/bootstrap-clinic-admin.ts',
          '--clinic-id',
          clinicB,
          '--email',
          'cli@x.example',
          '--display-name',
          'Cli',
        ],
        {
          input: `${password}\n`,
          encoding: 'utf8',
          env: { ...process.env },
        },
      );
    const weak = run('short');
    expect(weak.status).toBe(1);
    expect(weak.stderr).toContain('weak password');
    expect(weak.stdout + weak.stderr).not.toContain('short\n');
    const first = run(GOOD);
    expect(first.status).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(GOOD);
    const second = run(GOOD);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('No change');
    expect(second.stdout + second.stderr).not.toContain(GOOD);
  }, 60_000);
});
