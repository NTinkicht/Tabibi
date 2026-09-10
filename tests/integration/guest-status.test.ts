import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/guest/status/route';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import { GuestStatusService } from '@/modules/guest-status';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  actor: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  targetEntry: randomUUID(),
  aheadEntry: randomUUID(),
  targetPatient: randomUUID(),
  aheadPatient: randomUUID(),
};
const target = {
  clinicId: ids.clinic,
  sessionId: ids.session,
  queueEntryId: ids.targetEntry,
};

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_credentials,guest_exchange_ids,appointment_recovery_receipts,
    appointment_lifecycle_receipts,appointment_booking_receipts,appointments,audit_events,
    queue_command_receipts,queue_reorder_receipts,queue_registration_receipts,queue_entries,
    patient_operational_records,session_command_receipts,consultation_sessions,schedule_templates,
    doctor_clinics,doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
     ($1,'wu17-reception','Reception'),($2,'wu17-doctor','Doctor')`,
    [ids.actor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu17','WU17 Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.actor],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
     (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status,declared_delay_minutes,delay_updated_at)
     VALUES($1,$2,$3,'2026-09-10','2026-09-10T09:00Z','2026-09-10T12:00Z','open',15,'2026-09-10T08:59Z')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
     (id,clinic_id,private_display_name,contact_phone)
     VALUES($1,$2,'Target Guest','0555000000'),
           ($3,$2,'Ahead Guest','0555000001')`,
    [ids.targetPatient, ids.clinic, ids.aheadPatient],
  );
  await pool.query(
    `INSERT INTO queue_entries
     (id,clinic_id,session_id,patient_id,state,source,registration_order,eligibility_order,public_display_label)
     VALUES($1,$3,$4,$5,'checked_in','walk_in',1,1,'G-016'),
           ($2,$3,$4,$6,'waiting','walk_in',2,NULL,'G-017')`,
    [
      ids.aheadEntry,
      ids.targetEntry,
      ids.clinic,
      ids.session,
      ids.aheadPatient,
      ids.targetPatient,
    ],
  );
});
afterAll(async () => pool.end());

async function liveBearer() {
  const service = new GuestAccessService(pool);
  const issued = await service.issue(
    target,
    ids.actor,
    new Date('2026-09-10T09:00:00Z'),
  );
  return service.consume(
    issued.exchangeId,
    target,
    new Date('2026-09-10T09:01:00Z'),
  );
}

async function targetPublicDisplayLabel() {
  const result = await pool.query<{ public_display_label: string }>(
    'SELECT public_display_label FROM queue_entries WHERE id=$1',
    [ids.targetEntry],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected target queue entry to exist');
  return row.public_display_label;
}

describe('WU17 guest queue-status read', () => {
  it('returns provisional status for waiting guests without exposing an exact live position', async () => {
    const credential = await liveBearer();
    const expectedPublicDisplayLabel = await targetPublicDisplayLabel();
    const service = new GuestStatusService(pool);
    const beforeCredential = await pool.query(
      'SELECT issued_at,expires_at,revoked_at FROM guest_credentials',
    );
    const beforeAudit = await pool.query<{ count: string }>(
      'SELECT count(*)::text count FROM audit_events',
    );

    const snapshot = await service.getSnapshot(
      credential.bearer,
      new Date('2026-09-10T09:02:00Z'),
    );

    expect(snapshot).toMatchObject({
      terminal: false,
      target,
      publicDisplayLabel: expectedPublicDisplayLabel,
      queueState: 'waiting',
      patientsAhead: null,
      positionKind: 'provisional',
      session: { status: 'open', declaredDelayMinutes: 15 },
    });
    expect(JSON.stringify(snapshot)).not.toContain('0555000000');
    expect(JSON.stringify(snapshot)).not.toContain('Target Guest');
    expect(
      await pool.query(
        'SELECT issued_at,expires_at,revoked_at FROM guest_credentials',
      ),
    ).toMatchObject({ rows: beforeCredential.rows });
    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text count FROM audit_events',
        )
      ).rows[0].count,
    ).toBe(beforeAudit.rows[0].count);
  });

  it('rejects revoked and expired credentials but preserves only a bounded terminal summary', async () => {
    const credential = await liveBearer();
    const service = new GuestStatusService(pool);

    await pool.query('UPDATE guest_credentials SET revoked_at=$1', [
      new Date('2026-09-10T09:02:00Z'),
    ]);
    await expect(
      service.getSnapshot(
        credential.bearer,
        new Date('2026-09-10T09:03:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    await pool.query(
      'UPDATE guest_credentials SET revoked_at=NULL,expires_at=$1',
      [new Date('2026-09-10T09:03:30Z')],
    );
    await expect(
      service.getSnapshot(
        credential.bearer,
        new Date('2026-09-10T09:04:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    await pool.query('UPDATE guest_credentials SET expires_at=$1', [
      new Date('2026-09-11T09:00:00Z'),
    ]);
    await pool.query(
      "UPDATE queue_entries SET state='cancelled',updated_at=$2 WHERE id=$1",
      [ids.targetEntry, new Date('2026-09-10T09:04:00Z')],
    );
    await expect(
      service.getSnapshot(
        credential.bearer,
        new Date('2026-09-10T09:05:00Z'),
      ),
    ).resolves.toEqual({
      generatedAt: '2026-09-10T09:05:00.000Z',
      terminal: true,
      finalStatus: 'cancelled',
    });
    await expect(
      service.getSnapshot(
        credential.bearer,
        new Date('2026-09-10T09:19:00.001Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });

  it('serves the cookie-authenticated API as no-store and rejects missing credentials generically', async () => {
    const credential = await liveBearer();
    const expectedPublicDisplayLabel = await targetPublicDisplayLabel();
    const ok = await GET(
      new Request('http://localhost/api/guest/status', {
        headers: {
          cookie: `__Host-tabibi_guest=${credential.bearer}`,
          'x-forwarded-for': '203.0.113.17',
        },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const body = await ok.json();
    expect(body.target).toEqual(target);
    expect(body.publicDisplayLabel).toBe(expectedPublicDisplayLabel);
    expect(body.positionKind).toBe('provisional');
    expect(body.patientsAhead).toBeNull();
    expect(JSON.stringify(body)).not.toContain('0555000000');

    const rejected = await GET(
      new Request('http://localhost/api/guest/status', {
        headers: { 'x-forwarded-for': '203.0.113.18' },
      }),
    );
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    await expect(rejected.json()).resolves.toEqual({
      error: 'Guest access rejected',
    });
  });

  it('rate-limits repeated credential polling while permitting normal polling cadence', async () => {
    const credential = await liveBearer();
    const request = () =>
      GET(
        new Request('http://localhost/api/guest/status', {
          headers: {
            cookie: `__Host-tabibi_guest=${credential.bearer}`,
            'x-forwarded-for': '203.0.113.19',
          },
        }),
      );

    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(request()).resolves.toMatchObject({ status: 200 });
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});
