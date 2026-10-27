// 设备：调用者自己登记的电脑（装了 bridge 桌面客户端的）。只能操作自己的设备；
// 设备那头按它的权限档放行（observe 只能看，control 才能点、输入、跑命令、写文件，越档时会在电脑上弹窗问人）。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { devicesEnabled, ownDevices, resolveDevice, deviceDispatch } from '../../runtime/devices.mjs';

defineGroup('devices', '设备', '你登记过的电脑：看屏幕、操作桌面、跑命令、读写文件、驱动它的浏览器。');

// 这些 op 只能经各自的专用通道（终端、端口转发），这里一律不收。
const BLOCKED = /^(pty|http)\./;
const KNOWN = ['sysinfo', 'state', 'shell', 'desktop', 'browser', 'fs.read', 'fs.write', 'fs.list', 'fs.glob', 'fs.stat', 'fs.mkdir', 'fs.move', 'fs.delete'];

function enabledOrThrow() {
  if (!devicesEnabled()) throw new OpError('unavailable', '这台服务器没开设备功能');
}

defineOp({
  name: 'devices.list', title: '列出我的设备',
  desc: '每台给出 id、名字、是否在线、权限档（tier：observe 只能看 / control 能操作）、能力（caps）、系统与客户端版本。',
  handler: async (ctx) => {
    enabledOrThrow();
    return {
      devices: ownDevices(ctx).map((d) => ({
        id: d.id, name: d.name, online: !!d.online, ...(d.sameMachine ? { sameMachineAsServer: true } : {}),
        tier: d.client?.tier || null, caps: d.client?.caps || [], os: d.client?.os || null, clientVersion: d.client?.version || null,
        ...(d.lastOnlineAt ? { lastOnlineAt: d.lastOnlineAt } : {}),
      })),
    };
  },
});

defineOp({
  name: 'devices.run', title: '在设备上执行一个动作',
  desc: [
    'op 与 args：',
    'sysinfo {}；',
    'shell { command, cwd?, timeoutMs? }（Windows 是 PowerShell）；',
    'desktop { action, … }：看用 active_window / windows / screenshot / zoom / uia_tree / wait_for_window，操作用 click / type / key / scroll / launch / uia_action / batch 等（坐标是最近一次 screenshot 图里的像素）；',
    'browser { action, … }：navigate / read_page / click / type / screenshot / eval 等，驱动设备上带登录态的浏览器；',
    'fs.read { path, encoding? } / fs.write { path, content, encoding?, append? } / fs.list { path? } / fs.glob { pattern, cwd? } / fs.stat / fs.mkdir / fs.move { path, to } / fs.delete { path, recursive? }（进回收站）。',
    '设备在 observe 档时，操作类动作会在电脑上弹窗问人（最多等 90 秒）。截图类结果里的图片是 base64。',
    '这是用户本人的真实电脑：只做被要求的事，发消息、删除、改设置之类先征得同意。',
  ].join(''),
  access: 'danger', slow: true,
  params: {
    device: { type: 'string', desc: '设备 id 或名字；只有一台在线时可省略' },
    op: { type: 'string', required: true, desc: KNOWN.join(' / ') },
    args: { type: 'object', default: {}, desc: '这个 op 的参数' },
    timeoutSec: { type: 'integer', min: 5, max: 310, default: 120, desc: '整体超时（秒）' },
  },
  example: { device: '我的笔记本', op: 'shell', args: { command: 'Get-Date' } },
  handler: async (ctx, args, env) => {
    enabledOrThrow();
    if (BLOCKED.test(args.op)) throw new OpError('bad_args', `${args.op} 只能经终端 / 端口转发通道使用`);
    const r = resolveDevice(ctx, { want: args.device || '' });
    if (r.error) throw new OpError(/找不到/.test(r.error) ? 'not_found' : 'unavailable', r.error);
    let timeoutMs = args.timeoutSec * 1000;
    if (args.op === 'shell') {
      const own = Number(args.args?.timeoutMs) || 120_000;
      timeoutMs = Math.max(timeoutMs, Math.min(own + 10_000, 310_000));
    }
    try {
      const result = await deviceDispatch(ctx, r.device.id, args.op, args.args || {}, {
        timeoutMs, by: 'api', title: env.keyLabel ? 'agent：' + env.keyLabel : (env.via === 'mcp' ? 'Claude（bridge 工具）' : 'agent 接口'),
        session: env.sessionId || '', signal: env.signal || null,
      });
      return { device: { id: r.device.id, name: r.device.name }, op: args.op, result };
    } catch (e) {
      throw new OpError('failed', String(e?.message || e));
    }
  },
});
