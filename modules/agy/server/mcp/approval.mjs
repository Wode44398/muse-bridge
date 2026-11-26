// agy 调 bridge 自家工具时的审批口径（与 Claude 分页 src/runtime/permissions.mjs 的 ownMcp 同一取舍）。
//
// agy 对 MCP 工具一律发 session/request_permission（readOnlyHint 也不认，11-19 探针实测），而 bridge 就是 ACP 客户端、
// 审批本来就由它答——所以没有对外副作用的那几样直接替用户点允许，不弹卡：
//   免审批：媒体生成、界面协同、手机文件的只读三样、侧边浏览器、工作区协同、内嵌图表、查 bridge 手册、只读的 bridge 操作、
//           看电脑（列设备 / 看屏幕 / 设备自己那个浏览器）、会话协作里只看的几样（列会话 / 读汇报 / 撤卡）、
//           手机操控里只看 / 只问 / 只记经验的动作、PR 状态、项目记忆（只碰 bridge 自己的数据目录）、插件声明为只读的工具。
//   照常审批：共享终端（在用户看着的 shell 里敲命令）、会改东西的 bridge 操作、动手操作电脑、写 / 删手机文件、
//           开子会话与发消息、会动手机的操控动作、改 PR 绑定 / 设置 / 分支、远程连接器（ext_*）、插件的写工具。
// 扩展中心的 stdio 连接器（mcp_<别的服务名>_*）不在这里放行，交给用户。

import { getOp } from '@bridge/core/agent-api/registry.mjs';
import { isDynamicReadOnly } from './auto-allow.mjs';
import { memberToolName } from './catalog.mjs';

// 操作表由服务端（agent-api/http.mjs）登记；这里不 import ops/index.mjs——它会挂常驻句柄，ACP 客户端的单测进程就退不出了。
// 操作表还没登记时查不到 → 一律按「要审批」处理（偏保守）。
//
// 只认工具名字段、整串匹配，绝不看标题：agy 跑命令（run_command）时审批的 title 就是命令原文，
// 标题里出现 mcp_bridge_browser 字样不代表这是 bridge 的工具（11-19 实测：按标题匹配会让带这串字的命令免审批直接执行）。
// 审批请求里的 name 一定有值（mcp_bridge_<工具>）。agy 给「同名但配置不同」的服务起的哈希名
//（mcp_bridge_<8 位哈希>_<工具>）不在放行之列——那不一定是 bridge 自己这一份，交给用户点。
const BRIDGE_TOOL_RE = /^mcp_bridge_([a-z0-9_]+)$/;

/** 从 agy 的审批请求里认出 bridge 工具名（只看 name，如 mcp_bridge_browser → browser）；不是返回 ''。 */
export function bridgeToolOf(toolCall = {}) {
  const m = BRIDGE_TOOL_RE.exec(String(toolCall?.name || '').trim());
  return m ? m[1] : '';
}

const ALWAYS = new Set([
  'media_image', 'media_video', 'media_speech', 'media_music', 'media_models', 'media_result',
  'ui_view', 'ui_open', 'ui_toast',
  'phone_list', 'phone_read', 'phone_scan',
  'browser', 'workspace', 'visualize_read_me', 'visualize_show_widget',
  'manual', 'tool_docs',
  'device_devices', 'device_inspect', 'device_browser',
  'list_sessions', 'read_session', 'dismiss_task',
  'pr_status',
  'project_memory_read', 'project_memory_write', 'project_memory_delete',
]);
// 手机操控（groups/phone.mjs）里只看 / 只问 / 只记经验的动作；与那边的 PHONE_READ_ACTIONS 同一张表（这里不 import 它：那边引了整套手机工具）
const PHONE_READ = new Set(['devices', 'screen', 'clipboard_get', 'recall', 'learn', 'wait', 'confirm']);

/** 这次调用要不要替用户直接允许。args = agy 带来的工具参数（rawInput）。 */
export function bridgeToolAutoAllow(toolCall = {}) {
  // 合并工具（pr / project_memory / phone_files）按 action 换回原工具名再判，口径与合并前一样；action 不认识就按合并名判（要审批）
  const tool = memberToolName(bridgeToolOf(toolCall), toolCall?.args);
  if (!tool) return false;
  if (ALWAYS.has(tool)) return true;
  if (tool === 'call') {
    const name = String(toolCall.args?.op || '');
    // 调试模式记反馈：只往服务端的反馈文件夹里写一份说明（只给主机管理员），每记一条都弹审批的话调试模式没法用
    if (name === 'feedback.harness') return true;
    const op = getOp(name);
    return !!op && op.access === 'read';
  }
  if (tool === 'phone_control') return PHONE_READ.has(String(toolCall.args?.action || ''));
  if (tool.startsWith('plugin_')) return isDynamicReadOnly(tool);
  return false;
}
