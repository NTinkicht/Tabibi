import { z } from 'zod';
import { WaitingRoomService } from '@/modules/waiting-room';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';

const paramsSchema = z.object({
  clinicId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

type Context = {
  params: Promise<{ clinicId: string; sessionId: string }>;
};

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId, sessionId } = paramsSchema.parse(await context.params);
    const snapshot = await new WaitingRoomService(getPool()).getPublicSnapshot(
      clinicId,
      sessionId,
    );
    return {
      status: 200,
      body: snapshot,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    };
  });
}
