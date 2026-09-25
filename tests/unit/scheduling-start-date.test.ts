import { describe, expect, it } from 'vitest';
import { SchedulingService } from '@/modules/scheduling';

describe('WU180 generated session start-date calendar boundary', () => {
  const scope = { clinicId: 'clinic', actorUserId: 'actor' };
  const input = { doctorId: 'doctor', daysAhead: 7 };
  const service = new SchedulingService({
    connect: () => {
      throw new Error('WU180_VALID_DATE_REACHED_DATABASE');
    },
  } as unknown as ConstructorParameters<typeof SchedulingService>[0]);

  it('rejects normalized, impossible and malformed dates before PostgreSQL', async () => {
    for (const startDate of [
      '2026-02-29',
      '2026-02-30',
      '2028-02-30',
      '2026-04-31',
      '2026-09-31',
      '2026-00-01',
      '0000-01-01',
      '2026-9-07',
      '2026-09-07T00:00:00Z',
    ]) {
      await expect(
        service.generateSessions(scope, { ...input, startDate }),
      ).rejects.toThrow(TypeError);
    }
  });

  it('preserves actual leap days and ordinary days, reaching the DB boundary', async () => {
    for (const startDate of ['2028-02-29', '2026-02-28', '2026-09-07']) {
      await expect(
        service.generateSessions(scope, { ...input, startDate }),
      ).rejects.toThrow('WU180_VALID_DATE_REACHED_DATABASE');
    }
  });

  it('retains the bounded generation horizon guard', async () => {
    for (const daysAhead of [0, 6, 367, 7.5, Number.NaN]) {
      await expect(
        service.generateSessions(scope, {
          doctorId: input.doctorId,
          startDate: '2028-02-29',
          daysAhead,
        }),
      ).rejects.toThrow(RangeError);
    }
  });
});
