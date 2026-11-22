import { SavedDoctorService } from '@/modules/saved-doctor';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedPatient } from '@/platform/http/patient-auth';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import { requireSameOrigin } from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; doctorId: string }> };

// Same-origin, budgeted mutations. PUT and DELETE are idempotent.
const ACCOUNT_LIMIT = 60;
const INGRESS_LIMIT = 600;
const INGRESS_BUCKET = 'patient-saved-doctors:ingress';

async function mutate(
  request: Request,
  context: Context,
  run: (
    service: SavedDoctorService,
    owner: string,
    clinicId: string,
    doctorId: string,
  ) => Promise<{ status: number; body?: unknown }>,
): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    requireSameOrigin(request);
    const withinSource = await consumeSignInBudget(
      INGRESS_BUCKET,
      INGRESS_LIMIT,
    );
    const withinAccount = await consumeSignInBudget(
      `patient-saved-doctors:account:${keyDigest(patient.userId)}`,
      ACCOUNT_LIMIT,
    );
    if (!withinSource || !withinAccount) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const { clinicId, doctorId } = await context.params;
    const result = await run(
      new SavedDoctorService(getPool()),
      patient.userId,
      clinicId,
      doctorId,
    );
    return { status: result.status, body: result.body ?? {} };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}

export function PUT(request: Request, context: Context): Promise<Response> {
  return mutate(request, context, async (service, owner, clinic, doctor) => {
    const { created } = await service.save(owner, clinic, doctor);
    return { status: created ? 201 : 200, body: { saved: true } };
  });
}

export function DELETE(request: Request, context: Context): Promise<Response> {
  return mutate(request, context, async (service, owner, clinic, doctor) => {
    await service.remove(owner, clinic, doctor);
    return { status: 200, body: { saved: false } };
  });
}
