import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listClinics = vi.fn();
const logError = vi.fn();

vi.mock('@/modules/clinic', () => ({
  PublicDiscoveryService: class {
    listClinics(...args: unknown[]) {
      return listClinics(...args);
    }
  },
}));
vi.mock('@/platform/database/pool', () => ({
  getPool: () => ({}),
}));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: logError }),
}));

import Home from '@/app/page';

describe('WU85 public discovery initial server render', () => {
  beforeEach(() => {
    listClinics.mockReset();
    logError.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the public directory in the initial HTML without private data', async () => {
    listClinics.mockResolvedValue([
      {
        name: 'Clinique de l’Espoir',
        defaultLocale: 'fr',
        enabledLocales: ['fr', 'ar'],
        wilayaCode: null,
        commune: null,
        addressLine: null,
        id: 'never-serialize-clinic',
        tenantKey: 'never-serialize-tenant',
        doctors: [
          {
            displayName: 'Dr. Nadia',
            specialtyCodes: [],
            id: 'never-serialize-doctor',
            userId: 'never-serialize-user',
          },
        ],
      },
    ]);
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('Clinique de l’Espoir');
    expect(html).toContain('Dr. Nadia');
    for (const secret of [
      'never-serialize-clinic',
      'never-serialize-tenant',
      'never-serialize-doctor',
      'never-serialize-user',
    ]) {
      expect(html).not.toContain(secret);
    }
    expect(listClinics).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    expect(logError).not.toHaveBeenCalled();
  });

  // TAB-P0-03 (#698): the clinic location and doctor specialties the API
  // already publishes are rendered as localized labels; raw codes and
  // identifiers never reach the HTML.
  it('renders clinic location and doctor specialties as localized labels', async () => {
    listClinics.mockResolvedValue([
      {
        name: 'Clinique des Pins',
        defaultLocale: 'fr',
        enabledLocales: ['fr'],
        wilayaCode: '16',
        commune: 'Hydra',
        addressLine: '12 rue des Pins',
        id: 'never-serialize-clinic',
        doctors: [
          {
            displayName: 'Dr. Amel',
            specialtyCodes: ['cardiology', 'internal_medicine'],
            id: 'never-serialize-doctor',
          },
          { displayName: 'Dr. Karim', specialtyCodes: [] },
        ],
      },
      {
        name: 'Cabinet sans adresse',
        defaultLocale: 'fr',
        enabledLocales: ['fr'],
        wilayaCode: null,
        commune: null,
        addressLine: null,
        doctors: [],
      },
    ]);
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('Adresse: 12 rue des Pins, Hydra, Alger');
    expect(html).toContain(
      'Dr. Amel<span class="publicDoctorSpecialties"> (Spécialités: Cardiologie, Médecine interne)</span>',
    );
    expect(html).toContain('<li>Dr. Karim</li>');
    // Only the first clinic has a location line.
    expect(html.match(/class="publicLocation"/g)).toHaveLength(1);
    for (const raw of [
      'cardiology',
      'internal_medicine',
      'never-serialize-clinic',
      'never-serialize-doctor',
    ]) {
      expect(html).not.toContain(raw);
    }
  });

  it('logs rejected SSR discovery and renders the privacy-safe retry UI', async () => {
    const error = new Error('database unavailable');
    listClinics.mockRejectedValue(error);
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('Le répertoire est momentanément indisponible.');
    expect(html).toContain('Réessayer');
    expect(html).not.toContain('database unavailable');
    expect(logError).toHaveBeenCalledWith(
      { err: error },
      'public discovery SSR fetch failed',
    );
  });

  it('bounds a stalled service even when it ignores cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    listClinics.mockImplementation(
      (_timeout: number, suppliedSignal: AbortSignal) => {
        signal = suppliedSignal;
        return new Promise(() => {});
      },
    );
    const pending = Home();
    await vi.advanceTimersByTimeAsync(2_500);
    const html = renderToStaticMarkup(await pending);
    expect(html).toContain('Le répertoire est momentanément indisponible.');
    expect(html).toContain('Réessayer');
    expect(signal?.aborted).toBe(true);
    expect(logError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: 'Public discovery SSR deadline exceeded',
        }),
      },
      'public discovery SSR fetch failed',
    );
    expect(listClinics).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
  });
});
