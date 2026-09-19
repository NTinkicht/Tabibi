import { createHmac } from 'node:crypto';
import { guestBearerSigningSecret } from '@/modules/guest-access';

export interface EtaRevisionInput {
  patientsAhead: number;
  declaredDelayMinutes: number;
  estimatedConsultationMinutes: number;
  estimateSource: 'fallback' | 'historical_median' | 'observed_median';
  observedSampleCount: number;
}

/**
 * Produce a deterministic non-reversible ETA revision from committed inputs.
 * The server-only guest signing secret is reused with an ETA-specific HMAC
 * domain so this token cannot disclose low-entropy duration/sample evidence.
 * A configured secret is mandatory; never fall back to an unkeyed checksum.
 */
export function createEtaRevision(input: EtaRevisionInput): string {
  const canonical = [
    input.patientsAhead,
    input.declaredDelayMinutes,
    input.estimatedConsultationMinutes,
    input.estimateSource,
    input.observedSampleCount,
  ].join(':');

  const digest = createHmac('sha256', guestBearerSigningSecret())
    .update('tabibi:eta-revision:v2\0', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');

  return `eta-v2-${digest.slice(0, 32)}`;
}
