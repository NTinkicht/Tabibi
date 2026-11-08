/** A request body over the byte limit; mapped to the generic 400 like bad JSON. */
export class BodyTooLargeError extends SyntaxError {}

/**
 * Read a JSON body without buffering more than `maxBytes`, whatever the
 * declared content-length says. Throws SyntaxError (or BodyTooLargeError) for
 * a missing, oversized or malformed body.
 */
export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new BodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
