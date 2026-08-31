import { closePool, getPool } from '../src/db.js';
import { seedDatabase } from '../src/seed.js';

await seedDatabase(getPool());
console.log('Catalog and provider inventory seeded');
await closePool();
