import { migrate } from './lib';

async function main(): Promise<void> {
  await migrate();
  console.log('Database migrations complete.');
}

void main();
