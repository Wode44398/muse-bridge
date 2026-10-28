// 服务端自己的更新：查 GitHub 发布仓库上有没有新版、按部署形态一键更新。同设置「连接与更新 / 关于 › 服务端更新」
// （routes/admin.mjs 的 /api/admin/server-update），业务在 runtime/server-update.mjs。只有服务器主机能用。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { getModule } from '../../modules/registry.mjs';
import { serverUpdateStatus, startServerUpdate } from '../../runtime/server-update.mjs';

defineGroup('server', '服务端更新', '这台 bridge 服务端自己的版本：查 GitHub 上有没有新版，一键更新（按部署形态：安装包里的本机服务端交给那台电脑的桌面客户端去装，git 部署跑更新脚本）。');

const drainAll = async () => { try { await getModule('dimensio')?.drainHarnesses?.(); } catch {} };
const CODE_OF = { 400: 'unavailable', 409: 'unavailable' };

defineOp({
  name: 'server.update_status', title: '查服务端有没有新版',
  desc: [
    'form 是部署形态：desktop（Windows 安装包里的本机服务端，版本对 GitHub 发布仓库）/ script（git 部署 + 守护进程，跑更新脚本拉代码）/ ',
    'docker / distro（发行版声明由部署方更新）/ manual。current 是服务端现在的版本，latest / newer / notes 是 GitHub 上的最新版与说明（只有 desktop 形态有），',
    'feed 是上次查 GitHub 的结果（ok=false 时 error 写着原因）；oneClick 为 true 时可调 server.update，否则 how 写着该怎么更新；',
    'job 是最近一次发起的更新，restart 不为空表示服务端正等对话跑完重启（reason=update 即在装更新）。',
  ].join(''),
  need: ['server.manage'],
  params: { refresh: { type: 'boolean', default: false, desc: '不看缓存，现在去 GitHub 查（最多等 15 秒）' } },
  handler: async (ctx, args) => serverUpdateStatus({ refresh: args.refresh }),
});

defineOp({
  name: 'server.update', title: '一键更新服务端',
  desc: [
    '先用 server.update_status 看 oneClick 与 newer，并征得用户同意（更新会让服务端重启一次，所有人的对话会在跑完后才动手，期间照常用）。',
    'desktop 形态：让服务端所在电脑上的桌面客户端下载新版，下好后等所有对话跑完自动安装、服务端随之重启（result.status：downloading 已开始 / latest 已是最新 / ',
    'refused 服务器用临时地址、重启后地址会换，被客户端拒绝 / busy 已在下载或等待安装）。script 形态：后台跑更新脚本，有新代码就等空闲重启，进度看 server.update_status 的 script 与服务端日志。',
  ].join(''),
  access: 'danger', need: ['server.manage'], slow: true,
  params: {},
  handler: async () => {
    const r = await startServerUpdate({ drain: drainAll });
    if (r.error) throw new OpError(CODE_OF[r.status] || 'failed', r.error);
    return r;
  },
});
