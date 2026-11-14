import {
  PublicBookableSessionService,
  type PublicBookableClinic,
} from '@/modules/public-availability';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';
import FindDoctorClient from './FindDoctorClient';
import type { BookableClinic } from './find-model';

// Public data must be in the initial HTML (docs/design/find-and-book.md).
export const dynamic = 'force-dynamic';

const SSR_TIMEOUT_MS = 2_000;

function toClient(clinics: PublicBookableClinic[]): BookableClinic[] | null {
  // Same deliberate allow-list as GET /api/public/bookable-sessions.
  const result: BookableClinic[] = [];
  for (const clinic of clinics) {
    if (
      (clinic.defaultLocale !== 'ar' && clinic.defaultLocale !== 'fr') ||
      !clinic.enabledLocales.every((l) => l === 'ar' || l === 'fr')
    ) {
      return null;
    }
    result.push({
      name: clinic.name,
      defaultLocale: clinic.defaultLocale,
      enabledLocales: clinic.enabledLocales as ('ar' | 'fr')[],
      wilayaCode: clinic.wilayaCode,
      commune: clinic.commune,
      addressLine: clinic.addressLine,
      doctors: clinic.doctors.map((doctor) => ({
        displayName: doctor.displayName,
        specialtyCodes: [...doctor.specialtyCodes],
        sessions: doctor.sessions.map((session) => ({
          serviceDate: session.serviceDate,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          selectionReference: session.selectionReference,
        })),
      })),
    });
  }
  return result;
}

export default async function FindDoctorPage() {
  let initial: BookableClinic[] | null = null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Find doctor SSR deadline exceeded'));
    }, SSR_TIMEOUT_MS);
  });
  try {
    const secret = process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('selection secret not configured');
    }
    const pool = getPool('public-discovery');
    const { clinics } = await Promise.race([
      new PublicBookableSessionService(
        pool,
        new PublicAvailabilitySelectionService(pool, secret),
      ).listPage(controller.signal, {}, 1),
      deadline,
    ]);
    initial = toClient(clinics);
  } catch (error) {
    getLogger().error({ err: error }, 'find doctor SSR fetch failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return <FindDoctorClient initial={initial} />;
}
