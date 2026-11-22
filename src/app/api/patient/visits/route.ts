import { z } from 'zod';
import {
  PatientVisitHistoryService,
  VISIT_HISTORY_DEFAULT_LIMIT,
  VISIT_HISTORY_MAX_LIMIT,
} from '@/modules/patient-visit-history';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedPatient } from '@/platform/http/patient-auth';

// TAB-P1-04 slice 3: read-only operational visit history for the signed-in
// patient. The owner is always the authenticated patient; no owner identifier
// is read from the request.
const querySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d{1,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(VISIT_HISTORY_MAX_LIMIT))
      .optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  return operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const page = await new PatientVisitHistoryService(getPool()).list(
      patient.userId,
      {
        limit: query.limit ?? VISIT_HISTORY_DEFAULT_LIMIT,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
    );
    return { status: 200, body: page };
  });
}
