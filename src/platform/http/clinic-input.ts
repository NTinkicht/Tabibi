import { z } from 'zod';

// TAB-P0-02 (#665): request shape for PATCH /api/clinics/{clinicId}. Locales
// travel as a pair so the clinic's default locale is always one of its enabled
// locales without depending on the stored row; `status` is not accepted here
// (deactivation hides the clinic from discovery and public booking).
const localeSchema = z.enum(['ar', 'fr']);

export const updateClinicSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().min(1).max(64).optional(),
    defaultLocale: localeSchema.optional(),
    enabledLocales: z.array(localeSchema).min(1).max(2).optional(),
  })
  .strict()
  .refine(
    (u) =>
      u.name !== undefined ||
      u.timezone !== undefined ||
      u.defaultLocale !== undefined,
    { message: 'at least one setting must be provided' },
  )
  .refine(
    (u) => (u.defaultLocale === undefined) === (u.enabledLocales === undefined),
    { message: 'defaultLocale and enabledLocales must be sent together' },
  )
  .refine(
    (u) =>
      u.enabledLocales === undefined ||
      new Set(u.enabledLocales).size === u.enabledLocales.length,
    { message: 'enabledLocales must not repeat a locale' },
  )
  .refine(
    (u) =>
      u.defaultLocale === undefined ||
      (u.enabledLocales ?? []).includes(u.defaultLocale),
    { message: 'defaultLocale must be one of enabledLocales' },
  );
