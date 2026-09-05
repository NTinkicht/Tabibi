import { Client } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';
import { migrate } from './lib';

if (getEnvironment().NODE_ENV === 'production')
  throw new Error('Development seed must not run in production.');
await migrate();
const client = new Client({ connectionString: getEnvironment().DATABASE_URL });
await client.connect();
try {
  await client.query(`INSERT INTO platform_metadata (key, value) VALUES ('seed_version', 'development-v1')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
} finally {
  await client.end();
}
console.log('Deterministic development seed complete.');
