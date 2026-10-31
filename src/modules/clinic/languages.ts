// TAB-P0-03 (#696): the languages public discovery can filter by. They are
// exactly the clinic locales the database accepts
// (clinics.enabled_locales <@ ARRAY['ar', 'fr'], 0002_clinic_scheduling_foundation.sql),
// so a language filter keeps only the clinics whose enabled locales include it.
export type DiscoveryLanguageCode = 'ar' | 'fr';

export function isDiscoveryLanguageCode(
  value: unknown,
): value is DiscoveryLanguageCode {
  return value === 'ar' || value === 'fr';
}
