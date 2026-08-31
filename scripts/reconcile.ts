import { request } from './http-client.js';

const report = await request('/api/reconciliation');
console.log(JSON.stringify(report, null, 2));
