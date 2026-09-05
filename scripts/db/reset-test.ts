import { Client } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';

const env = getEnvironment();
if (
  env.NODE_ENV !== 'test' ||
  !/(_test|\/tabibi_test)(\?|$)/.test(env.DATABASE_URL)
) {
  throw new Error(
    'Refusing reset: NODE_ENV=test and a database name ending in _test are required.',
  );
}
const client = new Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
} finally {
  await client.end();
}
console.log('Test database reset complete.');
