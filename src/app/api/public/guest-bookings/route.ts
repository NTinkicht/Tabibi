import { z } from 'zod';
import {
  availabilitySelectionSecret,
  PublicAvailabilitySelectionService,
} from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';

const bookingSchema = z.object({
  selectionReference: z.string().min(1).max(4096),
  privateDisplayName: z.string().min(1).max(120),
  contactPhone: z.string().min(1).max(32).nullish(),
  contactEmail: z.string().min(1).max(254).nullish(),
  preferredLocale: z.enum(['ar', 'fr']),
  contactPreference: z.enum(['none', 'phone', 'email']),
});

export async function POST(request: Request): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    const input = bookingSchema.parse(await request.json());
    const pool = getPool();
    const selections = new PublicAvailabilitySelectionService(
      pool,
      availabilitySelectionSecret(),
    );
    const booking = await new PublicGuestBookingService(
      pool,
      selections,
    ).book({
      selectionReference: input.selectionReference,
      privateDisplayName: input.privateDisplayName,
      contactPhone: input.contactPhone ?? null,
      contactEmail: input.contactEmail ?? null,
      preferredLocale: input.preferredLocale,
      contactPreference: input.contactPreference,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      correlationId,
    });
    return { status: 201, body: booking };
  });
}
