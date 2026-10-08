import { build } from 'esbuild';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

// Embed only public Vite output, so the Sites Worker serves assets and /api
// together without any filesystem access or assumptions about asset bindings.
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const assets = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) throw new Error('Hidden files are forbidden in public assets');
    const path = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(path, relative);
    else if (entry.isFile()) assets[relative] = { type: mime[extname(path)] || 'application/octet-stream', bytes: (await readFile(path)).toString('base64') };
    else throw new Error('Public assets must be regular files');
  }
}
await collect('dist/client');
if (!assets['/index.html']) throw new Error('Missing frontend build');
const result = await build({ entryPoints: ['server/worker.mjs'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const source = result.outputFiles[0].text.replace(/export \{\s*([\s\S]*?)\s*\};\s*$/, '');
// esbuild's entry default export is named worker_default in this fixed entry.
if (!/var worker_default\s*=/.test(source)) throw new Error('Worker default export missing');
const staticHandler = `
const publicAssets = ${JSON.stringify(assets)};
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return worker_default.fetch(request, env, ctx);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status: 405, headers: SECURITY_HEADERS});
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', {status: 400, headers: SECURITY_HEADERS}); }
    if (path.includes('\\0') || path.includes('\\\\') || path.split('/').some(s => s.startsWith('.'))) return new Response('Not found', {status: 404, headers: SECURITY_HEADERS});
    let asset = publicAssets[path === '/' ? '/index.html' : path];
    if (!asset && !path.split('/').pop().includes('.')) asset = publicAssets['/index.html'];
    if (!asset) return new Response('Not found', {status: 404, headers: SECURITY_HEADERS});
    const headers = {...SECURITY_HEADERS, 'Content-Type': asset.type, 'Cache-Control': asset.type.startsWith('text/html') ? 'no-cache' : path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'};
    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.bytes), c => c.charCodeAt(0)), {headers});
  }
};
`;
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await writeFile('dist/server/index.js', source + staticHandler);
await writeFile('dist/.openai/hosting.json', await readFile('.openai/hosting.json'));
console.log(`Sites Worker built with ${Object.keys(assets).length} public assets; no runtime credentials are bundled.`);
