// TAB-P0-03 (#687, #669 Q2 = A): the controlled list of medical specialties a
// clinic may assign to one of its doctors (1 to 3 per clinic-doctor
// association). The list is versioned: the database CHECK on
// doctor_clinics.specialty_codes (0041_clinic_doctor_specialties.sql) accepts
// exactly these codes, and a later change ships as a new version together
// with a forward migration, never as an in-place edit of this one.
export const SPECIALTY_LIST_VERSION = 'tabibi-specialties-v1';

export const MAX_SPECIALTIES_PER_ASSOCIATION = 3;

export interface Specialty {
  code: string;
  labels: { ar: string; fr: string };
}

export const SPECIALTIES: readonly Specialty[] = Object.freeze(
  (
    [
      ['general_medicine', 'الطب العام', 'Médecine générale'],
      ['pediatrics', 'طب الأطفال', 'Pédiatrie'],
      ['gynecology', 'أمراض النساء والتوليد', 'Gynécologie-obstétrique'],
      ['cardiology', 'أمراض القلب', 'Cardiologie'],
      ['dermatology', 'الأمراض الجلدية', 'Dermatologie'],
      ['ophthalmology', 'طب العيون', 'Ophtalmologie'],
      ['ent', 'أمراض الأنف والأذن والحنجرة', 'ORL'],
      ['dentistry', 'طب الأسنان', 'Chirurgie dentaire'],
      ['internal_medicine', 'الطب الداخلي', 'Médecine interne'],
      ['endocrinology', 'أمراض الغدد والسكري', 'Endocrinologie-diabétologie'],
      ['gastroenterology', 'أمراض الجهاز الهضمي', 'Gastro-entérologie'],
      ['pulmonology', 'أمراض الرئة', 'Pneumologie'],
      ['neurology', 'طب الأعصاب', 'Neurologie'],
      ['psychiatry', 'الطب النفسي', 'Psychiatrie'],
      ['rheumatology', 'أمراض الروماتيزم', 'Rhumatologie'],
      ['orthopedics', 'جراحة العظام', 'Orthopédie-traumatologie'],
      ['urology', 'جراحة المسالك البولية', 'Urologie'],
      ['nephrology', 'أمراض الكلى', 'Néphrologie'],
      ['general_surgery', 'الجراحة العامة', 'Chirurgie générale'],
      ['physiotherapy', 'العلاج الطبيعي', 'Médecine physique et réadaptation'],
    ] as const
  ).map(([code, ar, fr]) =>
    Object.freeze({ code, labels: Object.freeze({ ar, fr }) }),
  ),
);

const CODES: ReadonlySet<string> = new Set(SPECIALTIES.map((s) => s.code));

export function isSpecialtyCode(value: unknown): value is string {
  return typeof value === 'string' && CODES.has(value);
}
