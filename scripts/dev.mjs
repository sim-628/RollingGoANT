import { spawn } from 'node:child_process';
const apiPort = process.env.ANT_API_PORT || '8787';
const webPort = process.env.ANT_WEB_PORT || '5173';
const runtimeEnv = { ...process.env, ANT_API_PORT: apiPort };
const api = spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit', env: runtimeEnv });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', webPort, '--strictPort'], { stdio: 'inherit', env: runtimeEnv });
let stopping = false;
function stop() { if (stopping) return; stopping = true; api.kill(); web.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
for (const child of [api, web]) {
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('exit', code => { if (code) process.exitCode = code; stop(); });
}
