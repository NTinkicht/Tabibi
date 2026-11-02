// TAB-P0-14/01 (#726): the sign-in page may send the user back to a staff
// page after sign-in. Only same-origin staff paths are accepted; anything
// else (absolute URLs, protocol-relative, backslashes, encoded tricks,
// control characters) falls back to null and the caller uses a safe default.
const ALLOWED_PREFIX = '/operations/';
const MAX_LENGTH = 512;

export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH)
    return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  for (const value of [raw, decoded]) {
    if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
    if (value.startsWith('//') || value.includes('://')) return null;
    if (!value.startsWith(ALLOWED_PREFIX)) return null;
    if (value.split(/[?#]/)[0].split('/').includes('..')) return null;
  }
  return raw;
}
