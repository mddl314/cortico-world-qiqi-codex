import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readOwner } from './owner.js';

if (process.argv.length !== 3) {
  console.error('用法：node setup.mjs "<包含 config.json 的 Cortico Bot 部署目录>"');
  process.exit(1);
}
const botDir = resolve(process.argv[2]);
if (!existsSync(join(botDir, 'config.json')) || !statSync(join(botDir, 'config.json')).isFile()) {
  throw new Error('找不到该 Bot 的 config.json。');
}
const directory = join(botDir, 'worlds', 'qiqi-codex');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (readOwner(directory).digest) throw new Error('已设置访问码，请从面板更改。');
const code = randomBytes(18).toString('base64url');
writeFileSync(join(directory, 'setup.sha256'), createHash('sha256').update(code).digest('hex') + '\n', { mode: 0o600 });
console.log('一次性初始化码：' + code);
console.log('打开 World 面板，输入初始化码，并设置你自己的访问码。');
