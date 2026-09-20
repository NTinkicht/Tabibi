import { summarizeWaitRange } from '@/modules/queue-eta-estimator';
import { formatWaitRangeSummary } from '@/modules/queue-eta-estimator/summary-format';
import {
  PublicGuestLiveQueueStatusRejectedError,
  PublicGuestLiveQueueStatusService,
} from '@/modules/public-guest-live-queue-status';
import { getPool } from '@/platform/database/pool';
import { observedJson } from '@/platform/http/request-context';

const GUEST_ETA_CONFIDENCE_THRESHOLDS = {
  highMaxWidthMinutes: 0,
  mediumMaxWidthMinutes: 15,
} as const;

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function rejected(requestId: string): { body: unknown; status: number } {
  return { body: { status: 'rejected', requestId }, status: 400 };
}

function bearerFrom(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const bearer = authorization.slice('Bearer '.length).trim();
  return bearer.length > 0 && bearer.length <= 4096 ? bearer : null;
}

export async function GET(request: Request): Promise<Response> {
  const response = await observedJson(request, async (requestId) => {
    const bearer = bearerFrom(request);
    if (!bearer) return rejected(requestId);

    try {
      const result = await new PublicGuestLiveQueueStatusService(getPool()).get(
        bearer,
        request.signal,
      );
      return {
        body: {
          bookingState: result.bookingState,
          queueState: result.queueState,
          pauseStatus: result.pauseStatus,
          closureStatus: result.closureStatus,
          activeConsultationRemainingMinutes:
            result.activeConsultationRemainingMinutes,
          eta: result.eta
            ? {
                patientsAhead: result.eta.patientsAhead,
                minWaitMinutes: result.eta.minWaitMinutes,
                maxWaitMinutes: result.eta.maxWaitMinutes,
                estimateSource: result.eta.estimateSource,
                revision: result.eta.revision,
                delayStatus: result.eta.delayStatus,
                summary: formatWaitRangeSummary(
                  summarizeWaitRange(
                    {
                      minWaitMinutes: result.eta.minWaitMinutes,
                      maxWaitMinutes: result.eta.maxWaitMinutes,
                    },
                    GUEST_ETA_CONFIDENCE_THRESHOLDS,
                  ),
                ),
              }
            : null,
        },
        status: 200,
      };
    } catch (error) {
      if (error instanceof PublicGuestLiveQueueStatusRejectedError) {
        return rejected(requestId);
      }
      throw error;
    }
  });

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
