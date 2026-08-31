import { closePool, getPool } from '../src/db.js';
import { resetBusinessData } from '../src/seed.js';

const db = getPool();
await resetBusinessData(db);
console.log('Business data reset');
await closePool();
