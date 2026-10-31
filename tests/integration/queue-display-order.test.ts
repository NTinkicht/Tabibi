import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import {
  isTerminalQueueState,
  orderQueueForDisplay,
  type QueueCommand,
} from '@/modules/queue/lifecycle-contract';
import { WaitingRoomService } from '@/modules/waiting-room';

// The staff list and the public waiting room follow the pure displayed
// service order contract (TAB-P0-04, #684) on real PostgreSQL.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
const queue = new QueueService(pool);

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'display-order-reception','Reception'),($2,'display-order-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'display-order-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
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
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
    VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
});
afterAll(() => pool.end());

let commandCount = 0;
function command(entryId: string, name: QueueCommand) {
  commandCount += 1;
  return queue.command(scope, ids.session, entryId, {
    command: name,
    idempotencyKey: `display-order-${name}-${commandCount}`,
    correlationId: `display-order-${commandCount}`,
    ...(name === 'cancel'
      ? { reason: 'Left the clinic', cancellationSource: 'patient' as const }
      : {}),
  });
}

async function prioritize(entryId: string, targetPosition: number) {
  const { queueOrderVersion } = await queue.listOperational(scope, ids.session);
  await queue.reorder(scope, ids.session, entryId, {
    targetPosition,
    expectedVersion: queueOrderVersion,
    idempotencyKey: `display-order-priority-${entryId}`,
    reason: 'Operational accommodation',
    correlationId: `display-order-priority-${entryId}`,
  });
}

describe('displayed service order projections follow the pure contract', () => {
  it('orders the staff list and the public waiting room exactly as orderQueueForDisplay', async () => {
    const entry: Record<string, string> = {};
    const label: Record<string, string> = {};
    for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      const registered = await queue.registerWalkIn(scope, ids.session, {
        privateDisplayName: `Patient ${name}`,
        preferredLocale: 'fr',
        idempotencyKey: `display-order-register-${name}`,
        correlationId: `display-order-register-${name}`,
      });
      entry[name] = registered.entry.id;
      label[registered.entry.publicDisplayLabel] = name;
    }
    // Out-of-order arrival: A registered first but checks in second (late).
    for (const name of ['C', 'A', 'E', 'F', 'G'])
      await command(entry[name]!, 'check_in');
    await prioritize(entry.E!, 1); // checked_in priority
    await prioritize(entry.G!, 2); // checked_in priority
    await prioritize(entry.D!, 3); // waiting entry holding a priority slot
    await command(entry.E!, 'call');
    await command(entry.E!, 'start_consultation');
    await command(entry.G!, 'call'); // next callable: remaining priority slot
    await command(entry.F!, 'cancel');

    const { entries } = await queue.listOperational(scope, ids.session);
    const byId = Object.fromEntries(
      Object.entries(entry).map(([name, id]) => [id, name]),
    );
    const names = (list: readonly { id: string }[]) =>
      list.map((candidate) => byId[candidate.id]);

    const active = entries.filter((e) => !isTerminalQueueState(e.state));
    const terminal = entries.filter((e) => isTerminalQueueState(e.state));
    // Active entries come first, in exactly the contract order; terminal last.
    expect(entries).toEqual([...active, ...terminal]);
    expect(names(terminal)).toEqual(['F']);
    expect(names(active)).toEqual(
      names(orderQueueForDisplay([...entries].reverse())),
    );
    expect(names(active)).toEqual(['E', 'G', 'C', 'A', 'D', 'B']);

    // The public projection is the contract order restricted to public states.
    const snapshot = await new WaitingRoomService(pool).getPublicSnapshot(
      ids.clinic,
      ids.session,
    );
    const publicStates = ['waiting', 'checked_in', 'called'];
    expect(
      snapshot.entries.map(
        (publicEntry) => label[publicEntry.publicDisplayLabel],
      ),
    ).toEqual(
      names(
        orderQueueForDisplay([...entries].reverse()).filter((e) =>
          publicStates.includes(e.state),
        ),
      ),
    );
    expect(snapshot.entries.map((publicEntry) => publicEntry.state)).toEqual([
      'called',
      'checked_in',
      'checked_in',
      'waiting',
      'waiting',
    ]);
  });
});
