import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export const readOnly = 'read';
export const readWrite = 'write';

export function contains(parent, child) {
  const part = relative(parent, child);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
}

export function validateAccess(value) {
  const { directory, mode, readPaths = [] } = value ?? {};
  if (mode !== readOnly && mode !== readWrite) throw new Error('请选择只读或读写。');
  if (!Array.isArray(readPaths) || readPaths.length > 16) {
    throw new Error('最多可以添加 16 条额外只读路径。');
  }
  return {
    directory: validatePath(directory, true),
    mode,
    readPaths: [...new Set(readPaths.map((path) => validatePath(path, false)))],
  };
}

function validatePath(path, requireDirectory) {
  const label = requireDirectory ? '工作文件夹' : '额外只读路径';
  const input = typeof path === 'string' ? path.trim().replace(/^"(.+)"$/, '$1') : '';
  if (!input || input.length > 1024 || !isAbsolute(input)
      || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(input))) {
    throw new Error(`${label}需要填写本机绝对路径${input ? `（${input.slice(0, 150)}）` : ''}。`);
  }
  let canonical;
  let stat;
  try {
    canonical = realpathSync.native(input);
    stat = statSync(canonical);
  } catch {
    throw new Error(`${label}不存在或 Cortico 无法访问：${input}`);
  }
  if (!stat.isDirectory() && (requireDirectory || !stat.isFile())) {
    throw new Error(`${label}的类型不合适：${input}`);
  }
  return canonical;
}

export function withinAccess(access, ceiling) {
  const canRead = (path) => [ceiling.directory, ...(ceiling.readPaths ?? [])].some((root) => contains(root, path));
  const canWrite = ceiling.mode === readWrite && contains(ceiling.directory, access.directory);
  return canRead(access.directory) && (access.readPaths ?? []).every(canRead) && (access.mode === readOnly || canWrite);
}

export function accessConfig({ directory, mode, readPaths = [] }) {
  const extraRules = readPaths.filter((path) => !contains(directory, path))
    .map((path) => `,${JSON.stringify(path)}="read"`).join('');
  return [
    '-c', 'default_permissions="qiqi-bridge"',
    '-c', `permissions.qiqi-bridge={filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="${mode}"}${extraRules}},network={enabled=false}}`,
  ];
}
