import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../dist/server/index.js';

const origin = 'https://ant-build.test';
const get = path => worker.fetch(new Request(origin + path), {}, {});
const home = await get('/');
assert.equal(home.status, 200);
assert.match(home.headers.get('content-type'), /text\/html/);
assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
const html = await home.text();
for (const path of html.matchAll(/(?:src|href)="(\/[^\"]+)"/g)) {
  assert.equal((await get(path[1])).status, 200, `Missing bundled asset: ${path[1]}`);
}
assert.equal((await get('/design/home-header.png')).status, 200);
for (const path of ['/.env', '/.git/config', '/.openai/hosting.json', '/server/worker.mjs', '/missing.js']) assert.equal((await get(path)).status, 404, path);
const health = await (await get('/api/health')).json();
assert.equal(health.data.order_mode, 'validate');
assert.equal(health.data.configured, false);
assert.equal((await get('/api/catalog/countries')).status, 503);
assert.equal((await get('/api/orders/create')).status, 404);
assert.equal((await get('/api/orders/demo/pay')).status, 404);
const source = await readFile('dist/server/index.js', 'utf8');
assert.doesNotMatch(source, /from ["']node:|process\.env|createServer\(/);
console.log('Compiled Worker smoke passed: same-origin assets/API, security headers, hidden-file isolation, demo-only boundary.');
