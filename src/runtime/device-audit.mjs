// 设备通道审计：谁在什么时候配对 / 上线 / 被派了什么 op / 下线。每天一份 JSONL。
// 只记元数据，**不记 op 的参数与回传内容**——那里面是对方屏幕截图、文件内容和命令输出。

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';

export const DEVICE_LOG_DIR = path.join(DATA_ROOT, 'logs', 'devices');

let dirReady = null;
const ensureDir = () => (dirReady ||= mkdir(DEVICE_LOG_DIR, { recursive: true }).catch(() => {}));

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 落一条审计。永不抛——日志写不进去不能拖垮设备通道。 */
export async function deviceAudit(entry) {
  try {
    await ensureDir();
    await appendFile(path.join(DEVICE_LOG_DIR, `devices-${stamp()}.jsonl`), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 尽力而为 */ }
}

/** 读最近的审计（新的在前），给控制台看。deviceId 可选过滤。 */
export async function readDeviceAudit({ limit = 200, deviceId = '' } = {}) {
  const out = [];
  let files = [];
  try { files = (await readdir(DEVICE_LOG_DIR)).filter((f) => /^devices-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse(); } catch { return out; }
  for (const f of files.slice(0, 7)) {
    let text = '';
    try { text = await readFile(path.join(DEVICE_LOG_DIR, f), 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (deviceId && e.device !== deviceId) continue;
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
