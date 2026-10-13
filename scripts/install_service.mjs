import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('此安装脚本需要 Linux 和 systemd 用户服务。其他系统请运行 npm start。');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (/[\r\n]/.test(root)) throw new Error('项目路径不能包含换行。');
const directory = resolve(homedir(), '.config/systemd/user');
const path = resolve(directory, 'enclosure-studio.service');
// Escape paths for systemd's own unit and command syntax.
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
await mkdir(directory, { recursive: true });
await writeFile(path, `[Unit]
Description=Enclosure Studio LAN workspace
After=network.target

[Service]
Type=simple
WorkingDirectory=${root.replaceAll('%', '%%')}
ExecStart=${quote(process.execPath)} ${quote(resolve(root, 'scripts/serve.mjs'))}
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
`);
const validation = spawnSync('systemd-analyze', ['--user', 'verify', path], { stdio: 'inherit' });
if (validation.status !== 0) process.exit(validation.status || 1);
for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'enclosure-studio.service']]) {
  const result = spawnSync('systemctl', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`已安装 systemd 用户服务：${path}`);
