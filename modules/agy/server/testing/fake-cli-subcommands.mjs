// 供单测与隔离集成测试使用的假 agy CLI 子命令处理器（模拟真实 agy 1.5.10 的 mcp / plugin / update / --version 输出与配置落盘）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function homeDir() {
  const override = process.env.AGY_HOME_DIR || process.env.USERPROFILE || process.env.HOME || os.tmpdir();
  return path.resolve(override);
}

function mcpConfigFile() {
  return path.join(homeDir(), '.gemini', 'config', 'mcp_config.json');
}

function pluginStoreFile() {
  return path.join(homeDir(), '.gemini', 'config', 'plugins-test.json');
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function maybeHandleFakeCliSubcommand(argv = process.argv.slice(2)) {
  const sub = argv[0] || '';
  if (!sub || sub === 'acp') return false;

  if (sub === '--version' || sub === '-v') {
    process.stdout.write('1.5.10\n');
    process.exit(0);
  }

  if (sub === 'update') {
    if (process.env.FAKE_AGY_UPDATE_MODE === 'updated') {
      process.stdout.write('Updated agy from 1.5.10 to 1.5.11\n');
    } else {
      process.stdout.write('agy is already up to date (1.5.10)\n');
    }
    process.exit(0);
  }

  if (sub === 'mcp') {
    const action = argv[1] || '';
    const cfg = readJsonSafe(mcpConfigFile(), { mcpServers: {} });
    const servers = cfg.mcpServers || {};

    if (action === 'list') {
      const entries = Object.entries(servers);
      if (!entries.length) {
        process.stdout.write('No MCP servers configured.\n');
        process.exit(0);
      }
      process.stdout.write('NAME        TYPE   STATUS    COMMAND/URL\n');
      for (const [name, s] of entries) {
        const type = s.serverUrl ? 'http' : 'stdio';
        const status = s.disabled ? 'disabled' : 'enabled';
        const target = s.serverUrl ? s.serverUrl : [s.command, ...(s.args || [])].join(' ');
        process.stdout.write(`${name.padEnd(12)}${type.padEnd(7)}${status.padEnd(10)}${target}\n`);
      }
      process.exit(0);
    }

    if (action === 'add') {
      const rest = argv.slice(2);
      const env = {};
      const headers = {};
      let explicitType = '';
      let idx = 0;
      while (idx < rest.length && rest[idx].startsWith('-')) {
        const flag = rest[idx++];
        if (flag === '--env' || flag === '-e') {
          const kv = String(rest[idx++] || '');
          const eq = kv.indexOf('=');
          if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
        } else if (flag === '--header' || flag === '-H') {
          const hv = String(rest[idx++] || '');
          const col = hv.indexOf(':');
          if (col > 0) headers[hv.slice(0, col).trim()] = hv.slice(col + 1).trim();
        } else if (flag === '--type' || flag === '-t') {
          explicitType = String(rest[idx++] || '');
        }
      }
      const name = rest[idx++];
      if (rest[idx] === '--') idx++;
      const cmdOrUrl = rest[idx++] || '';
      const cmdArgs = rest.slice(idx);
      if (!name || !cmdOrUrl) {
        process.stderr.write('Error: missing name or command\n');
        process.exit(1);
      }
      const isHttp = explicitType === 'http' || /^https?:\/\//i.test(cmdOrUrl);
      servers[name] = isHttp
        ? { serverUrl: cmdOrUrl, disabled: false, ...(Object.keys(headers).length ? { headers } : {}) }
        : { command: cmdOrUrl, args: cmdArgs, disabled: false, ...(Object.keys(env).length ? { env } : {}) };
      writeJsonSafe(mcpConfigFile(), { mcpServers: servers });
      process.stdout.write(`Added MCP server "${name}" (${isHttp ? 'http' : 'stdio'})\n`);
      process.exit(0);
    }

    if (action === 'enable' || action === 'disable') {
      const name = argv[2] || '';
      if (!servers[name]) {
        process.stderr.write(`Error: MCP server "${name}" not found\n`);
        process.exit(1);
      }
      servers[name].disabled = action === 'disable';
      writeJsonSafe(mcpConfigFile(), { mcpServers: servers });
      process.stdout.write(`${action === 'enable' ? 'Enabled' : 'Disabled'} MCP server "${name}"\n`);
      process.exit(0);
    }

    if (action === 'remove') {
      const name = argv[2] || '';
      if (!servers[name]) {
        process.stderr.write(`Error: MCP server "${name}" not found\n`);
        process.exit(1);
      }
      delete servers[name];
      writeJsonSafe(mcpConfigFile(), { mcpServers: servers });
      process.stdout.write(`Removed MCP server "${name}"\n`);
      process.exit(0);
    }
  }

  if (sub === 'plugin' || sub === 'plugins') {
    const action = argv[1] || '';
    const store = readJsonSafe(pluginStoreFile(), []);

    if (action === 'list') {
      if (argv.includes('--json')) {
        process.stdout.write(JSON.stringify(store, null, 2) + '\n');
      } else if (!store.length) {
        process.stdout.write('No plugins installed.\n');
      } else {
        process.stdout.write('Installed plugins:\n');
        for (const p of store) {
          process.stdout.write(`- ${p.name} (${p.enabled ? 'enabled' : 'disabled'}, ${p.version || '1.0.0'})\n`);
        }
      }
      process.exit(0);
    }

    if (action === 'install') {
      const target = argv[2] || '';
      if (!target) {
        process.stderr.write('Error: missing install target\n');
        process.exit(1);
      }
      const name = path.basename(target.replace(/[@/\\]+$/, '')).split('@')[0] || 'plugin';
      const existing = store.find((p) => p.name === name);
      if (existing) existing.enabled = true;
      else store.push({ name, enabled: true, version: '1.0.0', source: 'local', path: target });
      writeJsonSafe(pluginStoreFile(), store);
      process.stdout.write(`  [ok]    ${name}\n`);
      process.exit(0);
    }

    if (action === 'enable' || action === 'disable') {
      const name = argv[2] || '';
      const hit = store.find((p) => p.name === name);
      if (!hit) {
        process.stderr.write(`Error: plugin "${name}" not found\n`);
        process.exit(1);
      }
      hit.enabled = action === 'enable';
      writeJsonSafe(pluginStoreFile(), store);
      process.stdout.write(`${action === 'enable' ? 'Enabled' : 'Disabled'} plugin "${name}"\n`);
      process.exit(0);
    }

    if (action === 'uninstall') {
      const name = argv[2] || '';
      const idx = store.findIndex((p) => p.name === name);
      if (idx < 0) {
        process.stderr.write(`Error: plugin "${name}" not found\n`);
        process.exit(1);
      }
      store.splice(idx, 1);
      writeJsonSafe(pluginStoreFile(), store);
      process.stdout.write(`Uninstalled plugin "${name}"\n`);
      process.exit(0);
    }
  }

  return false;
}
