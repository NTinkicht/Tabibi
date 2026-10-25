import { z } from 'zod';
import { SchedulingService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  createTemplateSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const doctorId = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get('doctorId'));
    const templates = await new SchedulingService(getPool()).listTemplates(
      scope,
      doctorId,
    );
    return { status: 200, body: { templates } };
  });
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const input = createTemplateSchema.parse(await request.json());
    const template = await new SchedulingService(getPool()).createTemplate(
      scope,
      input,
    );
    return { status: 201, body: { template } };
  });
}
