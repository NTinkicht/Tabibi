import { z } from 'zod';
import { isWilayaCode } from '@/modules/clinic';

// TAB-P0-02 (#665): request shape for PATCH /api/clinics/{clinicId}. Locales
// travel as a pair so the clinic's default locale is always one of its enabled
// locales without depending on the stored row; `status` is not accepted here
// (deactivation hides the clinic from discovery and public booking).
//
// TAB-P0-02 (#686): the clinic location also travels as a whole. All three
// keys are sent together, each nullable; `null` clears that part. A commune
// or address without a wilaya is rejected, matching the database constraint,
// so a partial update can never leave a location without its wilaya.
const localeSchema = z.enum(['ar', 'fr']);

export const updateClinicSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().min(1).max(64).optional(),
    defaultLocale: localeSchema.optional(),
    enabledLocales: z.array(localeSchema).min(1).max(2).optional(),
    wilayaCode: z
      .string()
      .refine(isWilayaCode, { message: 'unknown wilaya code' })
      .nullable()
      .optional(),
    commune: z.string().trim().min(1).max(100).nullable().optional(),
    addressLine: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine(
    (u) =>
      u.name !== undefined ||
      u.timezone !== undefined ||
      u.defaultLocale !== undefined ||
      u.wilayaCode !== undefined,
    { message: 'at least one setting must be provided' },
  )
  .refine(
    (u) =>
      (u.wilayaCode === undefined) === (u.commune === undefined) &&
      (u.wilayaCode === undefined) === (u.addressLine === undefined),
    { message: 'wilayaCode, commune and addressLine must be sent together' },
  )
  .refine(
    (u) =>
      u.wilayaCode !== null || (u.commune === null && u.addressLine === null),
    { message: 'commune and addressLine require a wilayaCode' },
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
