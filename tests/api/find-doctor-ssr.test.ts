import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listPage = vi.fn();
const logError = vi.fn();

vi.mock('@/modules/public-availability', () => ({
  PublicBookableSessionService: class {
    listPage(...args: unknown[]) {
      return listPage(...args);
    }
  },
}));
vi.mock('@/modules/public-availability-selection', () => ({
  PublicAvailabilitySelectionService: class {},
}));
vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: logError }),
}));

import Home from '@/app/page';

const SECRET = 'x'.repeat(32);
const clinic = {
  name: 'Clinique A',
  defaultLocale: 'fr',
  enabledLocales: ['fr'],
  wilayaCode: '09',
  commune: 'Blida',
  addressLine: null,
  privateTenantKey: 'must-not-cross',
  doctors: [
    {
      displayName: 'Dr A',
      specialtyCodes: [],
      internalId: 'must-not-cross',
      sessions: [
        {
          serviceDate: '2026-11-20',
          startsAt: '2026-11-20T08:00:00Z',
          endsAt: '2026-11-20T12:00:00Z',
          selectionReference: 'v1.abcdefgh.xyz',
          capacity: 99,
        },
      ],
    },
  ],
};

async function initialProp() {
  const element = (await Home()) as ReactElement<{
    initial: unknown;
  }>;
  return element.props.initial;
}

describe('find doctor initial server render', () => {
  beforeEach(() => {
    listPage.mockReset();
    logError.mockReset();
    vi.stubEnv('PUBLIC_AVAILABILITY_SELECTION_SECRET', SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('passes the allow-listed first page and hasMore to the client', async () => {
    listPage.mockResolvedValue({ clinics: [clinic], hasMore: true });
    const initial = (await initialProp()) as {
      clinics: unknown[];
      hasMore: boolean;
    };
    expect(initial.hasMore).toBe(true);
    expect(JSON.stringify(initial)).not.toContain('must-not-cross');
    expect(JSON.stringify(initial)).not.toContain('capacity');
    expect(initial.clinics).toEqual([
      {
        name: 'Clinique A',
        defaultLocale: 'fr',
        enabledLocales: ['fr'],
        wilayaCode: '09',
        commune: 'Blida',
        addressLine: null,
        doctors: [
          {
            displayName: 'Dr A',
            specialtyCodes: [],
            sessions: [
              {
                serviceDate: '2026-11-20',
                startsAt: '2026-11-20T08:00:00Z',
                endsAt: '2026-11-20T12:00:00Z',
                selectionReference: 'v1.abcdefgh.xyz',
              },
            ],
          },
        ],
      },
    ]);
    expect(listPage).toHaveBeenCalledWith(expect.anything(), {}, 1);
  });

  it('falls back to null and logs when the service fails', async () => {
    listPage.mockRejectedValue(new Error('db down'));
    expect(await initialProp()).toBeNull();
    expect(logError).toHaveBeenCalledOnce();
  });

  it('falls back to null without querying when the secret is unusable', async () => {
    vi.stubEnv('PUBLIC_AVAILABILITY_SELECTION_SECRET', 'short');
    expect(await initialProp()).toBeNull();
    expect(listPage).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });

  it('falls back to null on an unsupported locale from the service', async () => {
    listPage.mockResolvedValue({
      clinics: [{ ...clinic, defaultLocale: 'en' }],
      hasMore: false,
    });
    expect(await initialProp()).toBeNull();
  });

  it('falls back to null at the deadline when the service never answers', async () => {
    vi.useFakeTimers();
    listPage.mockReturnValue(new Promise(() => {}));
    const pending = initialProp();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await pending).toBeNull();
    expect(logError).toHaveBeenCalledOnce();
  });
});
