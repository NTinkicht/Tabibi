import { AuthorizationError } from '@/modules/identity';
import { SessionService, SessionValidationError } from '@/modules/session';
import { getPool } from '@/platform/database/pool';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';
import { observedJson } from '@/platform/http/request-context';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export async function GET(
  request: Request,
  context: { params: Promise<{ clinicId: string }> },
) {
  return observedJson(request, async () => {
    try {
      const { clinicId } = await context.params;
      const date = new URL(request.url).searchParams.get('date') ?? '';
      if (!datePattern.test(date))
        throw new SessionValidationError('date must use YYYY-MM-DD');
      const scope = await authenticatedClinicScope(
        getPool(),
        request,
        clinicId,
      );
      return {
        status: 200,
        body: {
          sessions: await new SessionService(getPool()).listSessions(
            scope,
            date,
          ),
        },
      };
    } catch (error) {
      if (error instanceof AuthorizationError)
        return { status: 403, body: { error: 'forbidden' } };
      if (error instanceof SessionValidationError)
        return { status: 400, body: { error: error.message } };
      throw error;
    }
  });
}
