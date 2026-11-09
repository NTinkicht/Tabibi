import { describe, expect, it } from 'vitest';
import {
  buildProfilePatch,
  formFromProfile,
  type ClinicProfile,
} from '@/app/operations/[clinicId]/settings/clinic-profile-model';
import { updateClinicSchema } from '@/platform/http/clinic-input';

// TAB-UI-15 (#829): the profile form only ever sends bodies the server schema
// accepts, and only the groups that changed.
const initial: ClinicProfile = {
  name: 'Clinique Ibn Sina',
  timezone: 'Africa/Algiers',
  defaultLocale: 'ar',
  enabledLocales: ['ar', 'fr'],
  wilayaCode: '16',
  commune: 'Bab El Oued',
  addressLine: '12 rue Didouche',
};

function patch(changes: Partial<ReturnType<typeof formFromProfile>>) {
  return buildProfilePatch(initial, {
    ...formFromProfile(initial),
    ...changes,
  });
}

describe('buildProfilePatch', () => {
  it('refuses an unchanged form', () => {
    expect(patch({})).toEqual({ ok: false, error: 'unchanged' });
  });

  it('sends only the changed name, trimmed', () => {
    expect(patch({ name: '  Clinique Nour ' })).toEqual({
      ok: true,
      body: { name: 'Clinique Nour' },
    });
  });

  it('refuses a blank name and an empty language set', () => {
    expect(patch({ name: '   ' })).toEqual({
      ok: false,
      error: 'name_required',
    });
    expect(patch({ enabledLocales: [] })).toEqual({
      ok: false,
      error: 'locale_required',
    });
  });

  it('refuses a default language that is not offered', () => {
    expect(patch({ enabledLocales: ['fr'], defaultLocale: 'ar' })).toEqual({
      ok: false,
      error: 'default_locale_not_offered',
    });
  });

  it('sends the location whole when any part changes', () => {
    const r = patch({ commune: ' Kouba ' });
    expect(r).toEqual({
      ok: true,
      body: {
        wilayaCode: '16',
        commune: 'Kouba',
        addressLine: '12 rue Didouche',
      },
    });
  });

  it('clears the whole location with the wilaya, never a partial one', () => {
    const r = patch({ wilayaCode: '' });
    expect(r).toEqual({
      ok: true,
      body: { wilayaCode: null, commune: null, addressLine: null },
    });
  });

  it('sends the locale pair together', () => {
    const r = patch({ enabledLocales: ['fr'], defaultLocale: 'fr' });
    expect(r).toEqual({
      ok: true,
      body: { defaultLocale: 'fr', enabledLocales: ['fr'] },
    });
  });

  it('only produces bodies the server schema accepts', () => {
    const forms = [
      { name: 'Autre' },
      { wilayaCode: '' },
      { wilayaCode: '31', commune: '', addressLine: '' },
      { enabledLocales: ['fr' as const], defaultLocale: 'fr' as const },
      { timezone: 'Africa/Tunis' },
    ];
    for (const f of forms) {
      const r = patch(f);
      expect(r.ok).toBe(true);
      if (r.ok) expect(updateClinicSchema.safeParse(r.body).success).toBe(true);
    }
  });
});
