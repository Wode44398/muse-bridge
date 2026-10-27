// bridge 的插件内核实例（进程单例）+ 插件状态文件。
//
// 状态存在数据根的 plugins.json（gitignore）：
//   { "version": 1,
//     "plugins": { "<id>": { "enabled": false, "config": { … } } },   // 只记用户改过的；没记的按目录默认
//     "local":   ["D:/dev/my-plugin"] }                                // 登记的本机开发目录
// 设置页 / agent 接口都改这一份；手工改了要重启服务才读。
//
// 核心代码查「某功能开着没」一律用 pluginOn(id)：插件系统还没启动（单测、脚本、不经 server.mjs 的进程）时恒为 true，
// 行为与插件化之前一致；启动之后看插件是否在启用中。
//
// 测试开关：BRIDGE_PLUGINS_OFF=a,b 假装这些插件被关了（不写盘），BRIDGE_PLUGINS_STATE=<文件> 换状态文件位置。

import path from 'node:path';
import { readJson, writeJson } from '../jsonfile.mjs';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { createKernel } from '../kernel/kernel.mjs';

export const PLUGINS_STATE_FILE = path.resolve(process.env.BRIDGE_PLUGINS_STATE || path.join(DATA_ROOT, 'plugins.json'));
const FORCED_OFF = new Set(String(process.env.BRIDGE_PLUGINS_OFF || '').split(',').map((s) => s.trim()).filter(Boolean));

const fileStore = {
  load() {
    const s = readJson(PLUGINS_STATE_FILE, null) || { version: 1, plugins: {}, local: [] };
    if (FORCED_OFF.size) {
      s.plugins = { ...(s.plugins || {}) };
      for (const id of FORCED_OFF) s.plugins[id] = { ...(s.plugins[id] || {}), enabled: false };
    }
    return s;
  },
  save(s) {
    // 测试开关强关的那几个不写回去（别把临时状态落成用户的选择）
    if (FORCED_OFF.size) {
      const disk = readJson(PLUGINS_STATE_FILE, null) || {};
      s = { ...s, plugins: { ...s.plugins } };
      for (const id of FORCED_OFF) {
        const was = disk.plugins?.[id];
        if (was) s.plugins[id] = { ...s.plugins[id], enabled: was.enabled };
        else if (s.plugins[id]) { const { enabled, ...rest } = s.plugins[id]; s.plugins[id] = rest; }
      }
    }
    writeJson(PLUGINS_STATE_FILE, s, 2);
  },
};

export const kernel = createKernel({ store: fileStore });

export function pluginOn(id) {
  if (!kernel.started) return true;
  return kernel.has(id) ? kernel.isActive(id) : false;
}

// 由老配置开关演变来的插件（手机文件、手机操控……）：插件系统没启动时仍按老开关算，启动后看插件。
export function pluginOr(id, legacy) {
  return kernel.started ? pluginOn(id) : !!legacy;
}

// 插件此刻生效的配置（没启用 / 没启动时为 null）。
export function pluginConfig(id) {
  return kernel.started ? kernel.configOf(id) : null;
}

// 关着的内置插件（前端门控用：/api/auth 下发，界面据此藏入口）。没启动时为空。
export function pluginsOff() {
  if (!kernel.started) return [];
  return kernel.list().filter((p) => p.source === 'builtin' && !p.active).map((p) => p.id);
}
