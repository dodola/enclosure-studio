import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');
const authFile = resolve(process.env.ENCLOSURE_AUTH_FILE || '.pi-state/login.json');
try {
  const config = JSON.parse(await readFile(authFile, 'utf8'));
  if (config.version !== 1 || !config.passwordHash || !config.internalToken) throw new Error();
} catch {
  console.error('请先运行 npm run setup:login 配置管理员账户。'); process.exit(1);
}
if (!existsSync('dist/index.html')) { console.error('请先运行 npm run build。'); process.exit(1); }
const port = process.env.ENCLOSURE_PORT || '5176';
const env = { ...process.env, ENCLOSURE_AUTH_FILE: authFile, ENCLOSURE_AUTH_REQUIRED: '1', GEOMETRY_URL: `http://127.0.0.1:${port}` };
const children = [
  spawn(resolve('.venv/bin/python'), ['-m', 'uvicorn', 'server.app:app', '--host', process.env.ENCLOSURE_HOST || '0.0.0.0', '--port', port], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, ['agent/server.mjs'], { cwd: root, env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
