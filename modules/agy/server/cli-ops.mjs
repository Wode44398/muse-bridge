// Antigravity CLI 运维与子命令封装：包装 agy mcp / agy plugin / agy update / --version，
// 解析真实表格与 JSON 输出（格式变化时保留原文降级展示），并提取登录身份邮箱与运行日志路径。

import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnAgyProcess, killProcessTree, agyDataDir, agyCredentialsPresent } from './acp/binary.mjs';
import { normalizeAgyPath } from './paths.mjs';

const SAFE_NAME_RE = /^[A-Za-z0-9._@-]{1,80}$/;

function effectiveHomeDir() {
  const override = String(process.env.AGY_HOME_DIR || '').trim();
  return override ? path.resolve(override) : os.homedir();
}

function buildCliEnv(extraEnv = null) {
  const home = String(process.env.AGY_HOME_DIR || '').trim();
  if (!home && !extraEnv) return process.env;
  return {
    ...process.env,
    ...(home ? { USERPROFILE: path.resolve(home), HOME: path.resolve(home) } : {}),
    ...(extraEnv || {}),
  };
}

export async function runAgyCli(args = [], { timeoutMs = 20_000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnAgyProcess(args, {
        cwd: os.tmpdir(),
        env: buildCliEnv(env),
      });
    } catch (err) {
      reject(new Error('无法启动 Antigravity CLI：' + (err?.message || String(err))));
      return;
    }

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killProcessTree(proc);
      reject(new Error(`Antigravity CLI 执行超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    timer.unref?.();

    proc.stdout?.on('data', (d) => { if (stdout.length < 256_000) stdout += String(d); });
    proc.stderr?.on('data', (d) => { if (stderr.length < 256_000) stderr += String(d); });

    proc.once('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killProcessTree(proc);
      reject(new Error('Antigravity CLI 执行失败：' + (err?.message || String(err))));
    });

    proc.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        combined: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
      });
    });
  });
}

// 读取文件尾部文本，避免超大运行日志一次性读爆内存
function readTailUtf8(filePath, maxBytes = 131_072) {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size <= 0) return '';
    if (st.size <= maxBytes) return readFileSync(filePath, 'utf8');
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      return buf.toString('utf8', 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function extractAccountFromLogText(logText = '') {
  const s = String(logText || '');
  if (!s) return { email: null, authMethod: null };

  // 取最后一次认证记录，确保切换账号后反映最新状态
  let email = null;
  let authMethod = null;
  for (const m of s.matchAll(/applyAuthResult:\s*email=([^\s,]+)(?:,\s*authMethod=([^\s,]+))?/g)) {
    if (m[1] && m[1].includes('@')) email = m[1].trim();
    if (m[2]) authMethod = m[2].trim();
  }
  if (!email) {
    for (const m of s.matchAll(/authenticated successfully as\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi)) {
      if (m[1]) email = m[1].trim();
    }
  }
  return { email, authMethod };
}

export function resolveAgyLogInfo(client) {
  const candidates = [];
  if (client?.logFile) candidates.push(path.resolve(client.logFile));
  const dataDir = agyDataDir();
  const logSubDir = path.join(dataDir, 'log');
  try {
    if (existsSync(logSubDir)) {
      const files = readdirSync(logSubDir)
        .filter((f) => /\.log$/i.test(f))
        .map((f) => {
          const full = path.join(logSubDir, f);
          let mtimeMs = 0;
          try { mtimeMs = statSync(full).mtimeMs; } catch {}
          return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of files.slice(0, 3)) candidates.push(item.full);
    }
  } catch {}
  candidates.push(path.join(dataDir, 'cli.log'));

  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const st = statSync(file);
        if (st.isFile() && st.size > 0) {
          return { path: file, exists: true, size: st.size };
        }
      }
    } catch {}
  }

  const primary = client?.logFile ? path.resolve(client.logFile) : path.join(dataDir, 'cli.log');
  let exists = false;
  let size = 0;
  try {
    if (existsSync(primary)) {
      const st = statSync(primary);
      exists = st.isFile();
      size = exists ? st.size : 0;
    }
  } catch {}
  return { path: primary, exists, size };
}

export function readAgyAccountInfo(client) {
  const st = client ? client.status() : {};
  const credsOnDisk = agyCredentialsPresent();
  const authed = st.authState === 'logged_out' ? false : (st.authState === 'authed' || credsOnDisk);

  let email = null;
  let authMethod = null;
  if (authed) {
    if (process.env.GEMINI_API_KEY && !credsOnDisk) {
      authMethod = 'gemini-api-key';
    }
    const sources = [];
    if (client?.logFile) sources.push(path.resolve(client.logFile));
    const logDir = path.join(agyDataDir(), 'log');
    try {
      if (existsSync(logDir)) {
        const logs = readdirSync(logDir)
          .filter((f) => /^(?:acp-server|cli)-.*\.log$/i.test(f))
          .sort()
          .reverse()
          .slice(0, 4)
          .map((f) => path.join(logDir, f));
        sources.push(...logs);
      }
    } catch {}
    for (const src of sources) {
      const parsed = extractAccountFromLogText(readTailUtf8(src));
      if (parsed.email) {
        email = parsed.email;
        authMethod = parsed.authMethod || authMethod;
        break;
      }
    }
  }

  return {
    authed,
    email,
    authMethod,
    tier: authed ? (st.tier || null) : null,
    authMethods: Array.isArray(st.authMethods) ? st.authMethods : [],
  };
}

let cachedCliVersion = '';
export async function getAgyCliVersion(client) {
  const fromInit = client?.status?.()?.agentInfo?.version;
  if (fromInit) {
    cachedCliVersion = String(fromInit);
    return cachedCliVersion;
  }
  if (cachedCliVersion) return cachedCliVersion;
  try {
    const res = await runAgyCli(['--version'], { timeoutMs: 8_000 });
    if (res.exitCode === 0 && res.stdout) {
      const firstLine = res.stdout.split(/\r?\n/)[0].trim();
      if (firstLine) cachedCliVersion = firstLine;
    }
  } catch {}
  return cachedCliVersion || null;
}

// 冷启动尚未创建过会话时，按需做一次轻量探测拿到实时订阅档（tier）与模型目录（configOptions）
let probeInflight = null;
export async function probeCatalogAndTierIfNeeded(client) {
  if (!client || client.lastCatalog) return;
  if (!agyCredentialsPresent() || client.authState === 'logged_out') return;
  if (probeInflight) return probeInflight;

  probeInflight = (async () => {
    try {
      await client.ensureStarted();
      if (client.lastCatalog) return;
      const list = await client.listSessions({ cwd: client.daemonCwd }).catch(() => []);
      if (Array.isArray(list) && list.length > 0 && list[0]?.sessionId) {
        const sid = list[0].sessionId;
        const wasMounted = client.mountedSessions?.has(sid);
        const probeCwd = (list[0].cwd ? normalizeAgyPath(list[0].cwd) : '') || client.daemonCwd;
        const res = await client.request('session/resume', {
          sessionId: sid,
          cwd: probeCwd,
          mcpServers: [],
        }, 25_000);
        if (res?._meta?.antigravity?.tier) client.lastTier = res._meta.antigravity.tier;
        if (res?.configOptions || res?.models || res?.modes) {
          client.lastCatalog = {
            models: res.models || null,
            modes: res.modes || null,
            configOptions: res.configOptions || [],
          };
        }
        if (!wasMounted) {
          await client.request('session/close', { sessionId: sid }, 8_000).catch(() => {});
        }
      }
    } catch {} finally {
      probeInflight = null;
    }
  })();
  return probeInflight;
}

function readMcpSidecarKeys() {
  const cfgPath = path.join(effectiveHomeDir(), '.gemini', 'config', 'mcp_config.json');
  try {
    if (!existsSync(cfgPath)) return {};
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

export function parseMcpListOutput(stdout = '', sidecarMap = {}) {
  const raw = String(stdout || '').trim();
  if (!raw || /^no mcp servers configured\.?$/i.test(raw)) {
    return { ok: true, parseError: false, items: [], rawOutput: raw };
  }

  const lines = raw.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const headIdx = lines.findIndex((l) => /^NAME\s+TYPE\s+STATUS\s+COMMAND\/URL/i.test(l.trim()));
  if (headIdx < 0) {
    return { ok: false, parseError: true, items: [], rawOutput: raw };
  }

  const items = [];
  for (let i = headIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^(\S+)\s+(\S+)\s+(enabled|disabled)\s+(.*)$/i.exec(line);
    if (!m) {
      return { ok: false, parseError: true, items: [], rawOutput: raw };
    }
    const name = m[1];
    const type = m[2].toLowerCase();
    const enabled = m[3].toLowerCase() === 'enabled';
    const target = m[4].trim();
    const extra = sidecarMap && sidecarMap[name] && typeof sidecarMap[name] === 'object'
      ? sidecarMap[name]
      : null;
    const envKeys = extra?.env && typeof extra.env === 'object' ? Object.keys(extra.env) : [];
    const headerKeys = extra?.headers && typeof extra.headers === 'object' ? Object.keys(extra.headers) : [];

    items.push({
      name,
      type,
      enabled,
      target,
      command: extra?.command || (type === 'stdio' ? target.split(/\s+/)[0] || '' : ''),
      args: Array.isArray(extra?.args) ? extra.args : [],
      url: extra?.serverUrl || (type !== 'stdio' ? target : ''),
      envKeys,
      headerKeys,
    });
  }

  return { ok: true, parseError: false, items, rawOutput: raw };
}

// agy mcp add 要求所有 flags 排在 <name> 之前，且带 '-' 的子命令参数必须用 '--' 分隔
export function buildMcpAddArgs({ name, type = 'stdio', command = '', url = '', args = [], env = {}, headers = {} } = {}) {
  const cleanName = String(name || '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    throw Object.assign(new Error('MCP 名称只允许字母、数字、点、下划线或连字符'), { status: 400 });
  }

  const isHttp = type === 'http' || /^https?:\/\//i.test(String(url || command || '').trim());
  const target = String(isHttp ? (url || command) : command).trim();
  if (!target) {
    throw Object.assign(new Error(isHttp ? '请填写 MCP 服务 URL' : '请填写 MCP 启动命令'), { status: 400 });
  }

  const cliArgs = ['mcp', 'add'];
  if (isHttp) cliArgs.push('--type', 'http');

  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      const key = String(k || '').trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw Object.assign(new Error(`环境变量名不合法：${key}`), { status: 400 });
      }
      cliArgs.push('--env', `${key}=${String(v ?? '')}`);
    }
  }

  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      const key = String(k || '').trim();
      if (!key) continue;
      cliArgs.push('--header', `${key}: ${String(v ?? '')}`);
    }
  }

  cliArgs.push(cleanName);
  if (isHttp) {
    cliArgs.push(target);
  } else {
    const cleanArgs = (Array.isArray(args) ? args : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);
    cliArgs.push('--', target, ...cleanArgs);
  }
  return cliArgs;
}

export async function listMcpServers() {
  const res = await runAgyCli(['mcp', 'list']);
  if (res.exitCode !== 0 && !res.stdout) {
    throw new Error(res.stderr || '读取 MCP 列表失败');
  }
  return parseMcpListOutput(res.stdout || res.combined, readMcpSidecarKeys());
}

export async function addMcpServer(spec = {}) {
  const cliArgs = buildMcpAddArgs(spec);
  const res = await runAgyCli(cliArgs);
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(res.combined || '添加 MCP 服务失败'), { status: 400 });
  }
  return listMcpServers();
}

export async function setMcpServerEnabled(name, enabled) {
  const cleanName = String(name || '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    throw Object.assign(new Error('MCP 名称不合法'), { status: 400 });
  }
  const res = await runAgyCli(['mcp', enabled ? 'enable' : 'disable', cleanName]);
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(res.combined || '切换 MCP 状态失败'), { status: 400 });
  }
  return listMcpServers();
}

export async function removeMcpServer(name) {
  const cleanName = String(name || '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    throw Object.assign(new Error('MCP 名称不合法'), { status: 400 });
  }
  const res = await runAgyCli(['mcp', 'remove', cleanName]);
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(res.combined || '删除 MCP 服务失败'), { status: 400 });
  }
  return listMcpServers();
}

export function parsePluginListOutput(stdout = '') {
  const raw = String(stdout || '').trim();
  if (!raw || /^no plugins installed\.?$/i.test(raw)) {
    return { ok: true, parseError: false, items: [], rawOutput: raw };
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const items = parsed
        .filter((p) => p && typeof p === 'object' && p.name)
        .map((p) => ({
          name: String(p.name),
          enabled: p.enabled !== false,
          version: p.version ? String(p.version) : '',
          source: p.source ? String(p.source) : '',
          path: p.path ? String(p.path) : '',
        }));
      return { ok: true, parseError: false, items, rawOutput: raw };
    }
  } catch {
    // 非 JSON 时继续尝试文本列表解析
  }

  if (/^installed plugins:/i.test(raw)) {
    const items = [];
    for (const m of raw.matchAll(/^-\s+(\S+)\s+\((enabled|disabled)(?:,\s*([^)]+))?\)/gim)) {
      items.push({
        name: m[1],
        enabled: m[2].toLowerCase() === 'enabled',
        version: (m[3] || '').trim(),
        source: '',
        path: '',
      });
    }
    if (items.length > 0) {
      return { ok: true, parseError: false, items, rawOutput: raw };
    }
  }

  return { ok: false, parseError: true, items: [], rawOutput: raw };
}

export async function listAgyPlugins() {
  const res = await runAgyCli(['plugin', 'list', '--json']);
  if (res.exitCode !== 0 && !res.stdout) {
    throw new Error(res.stderr || '读取插件列表失败');
  }
  return parsePluginListOutput(res.stdout || res.combined);
}

export async function installAgyPlugin(target) {
  const clean = String(target || '').trim();
  if (!clean || clean.startsWith('-')) {
    throw Object.assign(new Error('请填写合法的插件目录路径或名称'), { status: 400 });
  }
  const res = await runAgyCli(['plugin', 'install', clean], { timeoutMs: 45_000 });
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(res.combined || '安装插件失败'), { status: 400 });
  }
  const next = await listAgyPlugins();
  return { ...next, installOutput: res.combined };
}

export async function setAgyPluginEnabled(name, enabled) {
  const cleanName = String(name || '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    throw Object.assign(new Error('插件名称不合法'), { status: 400 });
  }
  const res = await runAgyCli(['plugin', enabled ? 'enable' : 'disable', cleanName]);
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(res.combined || '切换插件状态失败'), { status: 400 });
  }
  return listAgyPlugins();
}

export async function uninstallAgyPlugin(name) {
  const cleanName = String(name || '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    throw Object.assign(new Error('插件名称不合法'), { status: 400 });
  }
  const res = await runAgyCli(['plugin', 'uninstall', cleanName]);
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(res.combined || '卸载插件失败'), { status: 400 });
  }
  return listAgyPlugins();
}

export async function runAgyUpdate() {
  const res = await runAgyCli(['update'], { timeoutMs: 60_000 });
  const output = res.combined || (res.exitCode === 0 ? '已是最新版本' : '检查更新失败');
  const alreadyLatest = /already\s+up[- ]to[- ]date|no\s+update|latest\s+version|up\s+to\s+date/i.test(output);
  const updated = res.exitCode === 0 && !alreadyLatest && /updat(ed|ing)|installed|new\s+version|upgraded/i.test(output);
  cachedCliVersion = '';
  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    output,
    updated,
  };
}
