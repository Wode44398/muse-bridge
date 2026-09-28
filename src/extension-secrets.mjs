// S3（#36、X02）：连接器凭据（stdio 的 env、http / sse 的 headers）不再明文躺在 registry.json 里。
//
//   extensions/connector-secrets.json   AES-256-GCM 密文：{ <扩展 id>: { env?: {…}, headers?: {…} } }
//   extensions/connector-secrets.key    数据密钥，Windows 上用 DPAPI（当前用户）包一层
//
// 同一台机器、同一个 Windows 账户才解得开：数据目录被备份、同步、拷走，或者被 grep / cat 扫到，拿到的都是密文。
// 同账户的进程照样能调 DPAPI 解开——这不是对本机 agent 的硬隔离（dimensio 那边另有密钥守卫挡着这两个文件）。
// 非 Windows 退化成权限 0600 的明文密钥文件（至少不和注册表躺在一起被一并读走）。
//
// 这里的函数都是同步的：Claude 每轮 query 现读连接器（claudeExtensionOptions 是同步的）。DPAPI 要起一次
// PowerShell（约半秒），数据密钥解开后按进程缓存；密文按文件 mtime 缓存。出错一律抛——调用方决定是拒绝保存
// 还是记进诊断，绝不静默当成「没有凭据」。
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import path from 'node:path';

export const SECRETS_FILE = 'connector-secrets.json';
export const KEY_FILE = 'connector-secrets.key';

// DPAPI 的附加熵：换个用途的 DPAPI 密文拿到这里也解不开
const ENTROPY = 'claude-bridge/connector-secrets/v1';

const psScript = (op) => [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in=[Console]::In.ReadToEnd().Trim()',
  `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
  `$o=[Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($in),$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
  '[Console]::Out.Write([Convert]::ToBase64String($o))',
].join(';');

// 明文经 stdin 进、不上命令行
function dpapi(op, b64) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript(op)], {
      input: b64, encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const why = String(e?.stderr || e?.message || e).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`DPAPI ${op === 'Protect' ? '加密' : '解密'}失败：${why}`);
  }
}

const keyCache = new Map();   // 扩展根 → { raw（密钥文件原文）, key }

function readKey(extRoot) {
  const file = path.join(extRoot, KEY_FILE);
  let rec;
  try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${KEY_FILE} 读不出来`); }
  if (rec?.scheme === 'dpapi' && typeof rec.blob === 'string') return Buffer.from(dpapi('Unprotect', rec.blob), 'base64');
  if (rec?.scheme === 'file' && typeof rec.key === 'string') return Buffer.from(rec.key, 'base64');
  throw new Error(`${KEY_FILE} 格式不认识`);
}

function createKey(extRoot) {
  const key = crypto.randomBytes(32);
  const rec = process.platform === 'win32'
    ? { v: 1, scheme: 'dpapi', blob: dpapi('Protect', key.toString('base64')) }
    : { v: 1, scheme: 'file', key: key.toString('base64') };
  mkdirSync(extRoot, { recursive: true });
  atomicWrite(path.join(extRoot, KEY_FILE), JSON.stringify(rec));
  // 写下去的要能原样解回来，才算数（DPAPI 半坏的机器上宁可现在报错）
  if (!readKey(extRoot).equals(key)) throw new Error('数据密钥写入后校验不一致');
  return key;
}

// 缓存按密钥文件的内容认：文件被换掉（从备份恢复、别的账户重建）或删掉，缓存跟着作废。
// 不按 mtime 认——Linux 的 overlay / tmpfs 时间戳粒度有几毫秒，同尺寸的新密钥会被当成旧的。
// 文件只有几十字节，每次读一下很便宜；贵的是 DPAPI 解包，那一步照样缓存。
function dataKey(extRoot, create) {
  const file = path.join(extRoot, KEY_FILE);
  if (!existsSync(file)) {
    keyCache.delete(extRoot);
    if (!create) return null;
    const key = createKey(extRoot);
    keyCache.set(extRoot, { raw: readFileSync(file, 'utf8'), key });
    return key;
  }
  const raw = readFileSync(file, 'utf8');
  const hit = keyCache.get(extRoot);
  if (hit && hit.raw === raw) return hit.key;
  const key = readKey(extRoot);
  keyCache.set(extRoot, { raw, key });
  return key;
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows 上只是尽力而为 */ }
}

let cache = null;   // { extRoot, mtimeMs, size, key, map }——密文文件或密钥换了都作废

// 全部连接器凭据（没有密文文件 = 还没存过任何凭据 → 空表）。解不开就抛。
export function readSecrets(extRoot) {
  const file = path.join(extRoot, SECRETS_FILE);
  if (!existsSync(file)) return {};
  const st = statSync(file);
  const key = dataKey(extRoot, false);
  if (!key) throw new Error(`密文还在，但数据密钥 ${KEY_FILE} 不见了`);
  if (cache && cache.extRoot === extRoot && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.key === key) return cache.map;
  let rec;
  try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${SECRETS_FILE} 读不出来`); }
  if (rec?.alg !== 'aes-256-gcm') throw new Error(`${SECRETS_FILE} 格式不认识`);
  let map;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    map = JSON.parse(Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error(`${SECRETS_FILE} 解不开（数据密钥对不上）`);
  }
  if (!map || typeof map !== 'object') map = {};
  cache = { extRoot, mtimeMs: st.mtimeMs, size: st.size, key, map };
  return map;
}

// 整表写回（加密、原子替换），写完解回来核对一遍。失败就抛——调用方绝不能退回明文存。
export function writeSecrets(extRoot, map) {
  const key = dataKey(extRoot, true);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(map), 'utf8'), c.final()]);
  const rec = { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  mkdirSync(extRoot, { recursive: true });
  atomicWrite(path.join(extRoot, SECRETS_FILE), JSON.stringify(rec));
  cache = null;
  const back = readSecrets(extRoot);
  if (JSON.stringify(back) !== JSON.stringify(map)) throw new Error('凭据写入后校验不一致');
}
