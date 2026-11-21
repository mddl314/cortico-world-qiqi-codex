import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readOptional(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function readOwner(directory) {
  const current = readOptional(join(directory, 'owner.json'));
  if (current) {
    const value = JSON.parse(current);
    if (typeof value.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.digest)
        || (value.salt !== undefined && !/^[a-f0-9]{32}$/.test(value.salt))) {
      throw new Error('面板访问设置无效。');
    }
    return value;
  }
  const digest = readOptional(join(directory, 'owner.sha256'));
  if (digest && !/^[a-f0-9]{64}$/.test(digest)) throw new Error('旧版面板访问设置无效。');
  return { enabled: true, digest };
}

export function matches(text, digest, salt) {
  if (!digest || typeof text !== 'string') return false;
  const candidate = salt ? scryptSync(text, salt, 32) : createHash('sha256').update(text).digest();
  return timingSafeEqual(candidate, Buffer.from(digest, 'hex'));
}

export function newOwner(passcode, enabled = true) {
  if (typeof passcode !== 'string' || !passcode.length) {
    throw new Error('请输入访问码。');
  }
  const salt = randomBytes(16).toString('hex');
  return { enabled, salt, digest: scryptSync(passcode, salt, 32).toString('hex') };
}
