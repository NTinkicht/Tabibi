/**
 * Link-intent material for push-originated links: `<exchangeId>.<subscriptionId>`.
 * It pins delivery to the binding that asked (initial subscribe, resend), so a
 * single-use link never goes to another device of the same entry. Material
 * without a binding (transfer) resolves the entry's most recent binding. The
 * material lives only inside the sealed intent envelope.
 */
const EXCHANGE_ID = /^[A-Za-z0-9_-]{16,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function pushLinkMaterial(
  exchangeId: string,
  subscriptionId: string,
): string {
  return `${exchangeId}.${subscriptionId}`;
}

export function parsePushLinkMaterial(
  material: string,
): { exchangeId: string; subscriptionId: string | null } | undefined {
  const [exchangeId, subscriptionId, ...rest] = material.split('.');
  if (rest.length > 0 || !exchangeId || !EXCHANGE_ID.test(exchangeId)) {
    return undefined;
  }
  if (subscriptionId === undefined) return { exchangeId, subscriptionId: null };
  return UUID.test(subscriptionId) ? { exchangeId, subscriptionId } : undefined;
}
