import { describe, expect, it } from 'vitest';
import type { ConsoleEntry } from '@/modules/receptionist-dashboard/console-view';
import { buildDoctorView } from '@/modules/receptionist-dashboard/doctor-view';
import { doctorCopy } from '@/modules/localization/doctor';

let seq = 0;
function entry(over: Partial<ConsoleEntry>): ConsoleEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    state: 'checked_in',
    registrationOrder: seq,
    eligibilityOrder: seq,
    priorityOrder: null,
    publicDisplayLabel: `A-${seq}`,
    privateDisplayName: `Patient ${seq}`,
    preferredLocale: 'fr',
    hasContact: false,
    origin: 'walk_in',
    appointmentStartsAt: null,
    activeConsultationRemainingMinutes: null,
    eta: null,
    ...over,
  };
}

describe('doctor view model', () => {
  it('maps the primary button: complete, then start, then call next', () => {
    const inC = entry({ id: 'i', state: 'in_consultation' });
    const called = entry({ id: 'c', state: 'called' });
    const waiting = entry({ id: 'w' });
    expect(buildDoctorView([inC, waiting], 'open').primary).toMatchObject({
      command: 'complete_consultation',
      entry: { id: 'i' },
      disabled: false,
    });
    expect(buildDoctorView([called, waiting], 'open').primary).toMatchObject({
      command: 'start_consultation',
      entry: { id: 'c' },
    });
    expect(buildDoctorView([waiting], 'open').primary).toMatchObject({
      command: 'call',
      entry: { id: 'w' },
    });
    expect(buildDoctorView([], 'open').primary).toBeNull();
  });

  it('never calls a not-yet-arrived entry', () => {
    const view = buildDoctorView([entry({ state: 'waiting' })], 'open');
    expect(view.primary).toBeNull();
    expect(view.notArrivedCount).toBe(1);
  });

  it('paused gates call and start but still allows completing', () => {
    expect(
      buildDoctorView([entry({ state: 'in_consultation' })], 'paused').primary
        ?.disabled,
    ).toBe(false);
    expect(
      buildDoctorView([entry({ state: 'called' })], 'paused').primary?.disabled,
    ).toBe(true);
    expect(buildDoctorView([entry({})], 'paused').primary?.disabled).toBe(true);
    expect(buildDoctorView([entry({})], 'paused').paused).toBe(true);
  });

  it('closed or planned sessions disable every primary command', () => {
    for (const status of ['closed', 'planned', 'cancelled'] as const) {
      expect(
        buildDoctorView([entry({ state: 'in_consultation' })], status).primary
          ?.disabled,
      ).toBe(true);
    }
  });

  it('offers no-show only for a called patient on an active session', () => {
    expect(
      buildDoctorView([entry({ state: 'called' })], 'open').canNoShow,
    ).toBe(true);
    expect(
      buildDoctorView([entry({ state: 'in_consultation' })], 'open').canNoShow,
    ).toBe(false);
    expect(buildDoctorView([entry({})], 'open').canNoShow).toBe(false);
    expect(
      buildDoctorView([entry({ state: 'called' })], 'closed').canNoShow,
    ).toBe(false);
  });

  it('lists at most four next arrived entries, excluding the one the button calls', () => {
    const queue = Array.from({ length: 7 }, (_, i) => entry({ id: `q${i}` }));
    const idle = buildDoctorView(queue, 'open');
    expect(idle.primary?.entry.id).toBe('q0');
    expect(idle.next.map((e) => e.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    const busy = buildDoctorView(
      [entry({ id: 'x', state: 'in_consultation' }), ...queue],
      'open',
    );
    expect(busy.next.map((e) => e.id)).toEqual(['q0', 'q1', 'q2', 'q3']);
  });

  it('counts completed and no-show entries for the today line', () => {
    const view = buildDoctorView(
      [
        entry({ state: 'completed' }),
        entry({ state: 'completed' }),
        entry({ state: 'no_show' }),
      ],
      'open',
    );
    expect([view.completedCount, view.noShowCount]).toEqual([2, 1]);
  });
});

describe('doctor copy', () => {
  it('has identical keys in fr and ar and no empty strings', () => {
    expect(Object.keys(doctorCopy.ar).sort()).toEqual(
      Object.keys(doctorCopy.fr).sort(),
    );
    for (const locale of ['fr', 'ar'] as const)
      for (const value of Object.values(doctorCopy[locale]))
        expect(value.trim()).not.toBe('');
  });
});
