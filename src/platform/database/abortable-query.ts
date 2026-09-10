import type { Pool, QueryResult, QueryResultRow } from 'pg';

/**
 * Run one PostgreSQL query on a dedicated pooled client and tear down that
 * connection if the caller aborts while the query is in flight.
 */
export async function abortableQuery<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<T>> {
  if (!signal) return pool.query<T>(text, values);

  signal.throwIfAborted();
  const client = await pool.connect();
  if (signal.aborted) {
    client.release();
    signal.throwIfAborted();
  }

  let destroyed = false;
  const onAbort = () => {
    destroyed = true;
    client.release(true);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await client.query<T>(text, values);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!destroyed) client.release();
  }
}
