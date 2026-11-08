import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueueRows } from '@/app/operations/[clinicId]/sessions/[sessionId]/queue/console-regions';
import {
  buildConsoleView,
  type ConsoleEntry,
} from '@/modules/receptionist-dashboard/console-view';
import { receptionistCopy } from '@/modules/localization/receptionist';

const entry: ConsoleEntry = {
  id: 'e1',
  state: 'checked_in',
  registrationOrder: 1,
  eligibilityOrder: 1,
  priorityOrder: null,
  publicDisplayLabel: 'A-1',
  privateDisplayName: 'Patient 1',
  preferredLocale: 'fr',
  hasContact: false,
  origin: 'appointment',
  appointmentStartsAt: '2026-03-10T09:00:00.000Z',
  activeConsultationRemainingMinutes: null,
  eta: null,
};

function render(timezone: string): string {
  const view = buildConsoleView([entry], 'open');
  return renderToStaticMarkup(
    createElement(QueueRows, {
      rows: view.queue,
      arrived: 1,
      notArrived: 0,
      h: {
        t: receptionistCopy.fr,
        locale: 'fr',
        timezone,
        busy: false,
        pendingEntryId: null,
        onPrimary: () => undefined,
        onPanel: () => undefined,
      },
    }),
  );
}

describe('console appointment time uses the clinic timezone', () => {
  it('shows 10:00 for 09:00Z at Africa/Algiers and 09:00 at UTC', () => {
    expect(render('Africa/Algiers')).toMatch(/Rendez-vous 10:00/);
    expect(render('UTC')).toMatch(/Rendez-vous 09:00/);
  });
});
