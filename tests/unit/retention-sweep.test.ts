import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patient: vi.fn(),
  staff: vi.fn(),
  rate: vi.fn(),
  guest: vi.fn(),
  receipts: vi.fn(),
  inbox: vi.fn(),
  guestRate: vi.fn(),
  push: vi.fn(),
  checkIn: vi.fn(),
}));
vi.mock('@/modules/public-guest-booking-check-in/retention', () => ({
  purgeExpiredGuestCheckInOperations: mocks.checkIn,
}));
vi.mock('@/modules/guest-push/retention', () => ({
  purgeRevokedPushBindings: mocks.push,
}));
vi.mock('@/modules/guest-access/rate-limit-retention', () => ({
  purgeStaleGuestRateLimitBuckets: mocks.guestRate,
}));
vi.mock('@/modules/notification-inbox/retention', () => ({
  purgeExpiredVisitInboxItems: mocks.inbox,
}));
vi.mock('@/modules/public-guest-booking', () => ({
  scrubExpiredBookingReceipts: mocks.receipts,
}));
vi.mock('@/modules/identity/patient-auth-retention', () => ({
  purgeExpiredPatientAuthArtifacts: mocks.patient,
}));
vi.mock('@/modules/identity/staff-auth-retention', () => ({
  purgeExpiredStaffAuthArtifacts: mocks.staff,
}));
vi.mock('@/modules/identity/rate-limit-retention', () => ({
  purgeStaleSignInRateLimitBuckets: mocks.rate,
}));
vi.mock('@/modules/guest-access/retention', () => ({
  purgeExpiredGuestExchangeArtifacts: mocks.guest,
}));

import { runRetentionSweep } from '@/modules/maintenance/retention-sweep';

const pool = {} as Pool;
const NOW = new Date('2026-06-01T12:00:00Z');

beforeEach(() => {
  mocks.patient.mockReset().mockResolvedValue({ sessions: 1, resetTokens: 2 });
  mocks.staff.mockReset().mockResolvedValue({ sessions: 3, invites: 4 });
  mocks.rate.mockReset().mockResolvedValue(5);
  mocks.guest.mockReset().mockResolvedValue({ exchangeIds: 6, linkIntents: 7 });
  mocks.receipts.mockReset().mockResolvedValue(8);
  mocks.inbox.mockReset().mockResolvedValue(9);
  mocks.guestRate.mockReset().mockResolvedValue(10);
  mocks.push.mockReset().mockResolvedValue(11);
  mocks.checkIn.mockReset().mockResolvedValue(12);
});

describe('runRetentionSweep', () => {
  it('runs every purge with the shared clock and reports counts', async () => {
    const result = await runRetentionSweep(pool, NOW);
    for (const fn of [
      mocks.patient,
      mocks.staff,
      mocks.rate,
      mocks.guest,
      mocks.receipts,
      mocks.inbox,
      mocks.guestRate,
      mocks.push,
      mocks.checkIn,
    ])
      expect(fn).toHaveBeenCalledWith(pool, NOW);
    expect(result).toEqual({
      deleted: {
        patient_auth: 3,
        staff_auth: 7,
        sign_in_rate_limit: 5,
        guest_rate_limit: 10,
        guest_exchange: 13,
        booking_receipt_scrub: 8,
        visit_inbox: 9,
        push_binding: 11,
        guest_check_in_operation: 12,
      },
      failed: [],
    });
  });

  it('keeps running the other tasks when one throws and leaks no error text', async () => {
    mocks.staff.mockRejectedValue(new Error('secret-row-detail 42'));
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual(['staff_auth']);
    expect(result.deleted).toEqual({
      patient_auth: 3,
      sign_in_rate_limit: 5,
      guest_rate_limit: 10,
      guest_exchange: 13,
      booking_receipt_scrub: 8,
      visit_inbox: 9,
      push_binding: 11,
      guest_check_in_operation: 12,
    });
    expect(JSON.stringify(result)).not.toContain('secret-row-detail');
    expect(mocks.guest).toHaveBeenCalledTimes(1);
  });

  it('reports a failing receipt scrub by name without stopping earlier tasks', async () => {
    mocks.receipts.mockRejectedValue(new Error('ciphertext-detail'));
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual(['booking_receipt_scrub']);
    expect(result.deleted.guest_exchange).toBe(13);
    expect(JSON.stringify(result)).not.toContain('ciphertext-detail');
  });

  it('reports a failing inbox purge by name without stopping other tasks', async () => {
    mocks.inbox.mockRejectedValue(new Error('inbox-body-detail'));
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual(['visit_inbox']);
    expect(result.deleted.booking_receipt_scrub).toBe(8);
    expect(JSON.stringify(result)).not.toContain('inbox-body-detail');
  });

  it('reports a failing guest rate-limit purge by name without stopping other tasks', async () => {
    mocks.guestRate.mockRejectedValue(new Error('bucket-key-detail'));
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual(['guest_rate_limit']);
    expect(result.deleted.visit_inbox).toBe(9);
    expect(JSON.stringify(result)).not.toContain('bucket-key-detail');
  });
});

describe('runRetentionSweep push bindings', () => {
  it('reports a failing push binding purge by name without stopping other tasks', async () => {
    mocks.push.mockRejectedValue(new Error('endpoint-hash-detail'));
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual(['push_binding']);
    expect(result.deleted.visit_inbox).toBe(9);
    expect(JSON.stringify(result)).not.toContain('endpoint-hash-detail');
  });
});

describe('runRetentionSweep guest check-in operations', () => {
  it('reports a failing check-in operation purge by name without stopping other tasks', async () => {
    mocks.checkIn.mockRejectedValue(new Error('operation-id-detail'));
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual(['guest_check_in_operation']);
    expect(result.deleted.push_binding).toBe(11);
    expect(JSON.stringify(result)).not.toContain('operation-id-detail');
  });
});

describe('runRetentionSweep guest check-in operations', () => {
  it('reports a failing check-in operation purge by name without stopping other tasks', async () => {
    mocks.checkIn.mockRejectedValue(new Error('operation-id-detail'));
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual(['guest_check_in_operation']);
    expect(result.deleted.push_binding).toBe(11);
    expect(JSON.stringify(result)).not.toContain('operation-id-detail');
  });
});
