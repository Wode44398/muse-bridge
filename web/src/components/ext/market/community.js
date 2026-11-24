// 社区插件市场的前端共用件（功能扩展页、社区详情、发布面板都用）：能力 / 种类的说法、安装前的风险确认、投稿状态。
// 能力按 id 在前端取词条，不用服务端的 capLabels——那是中文原文，英文界面还得再 tr() 一遍。
import { t, tr, isEn } from '../../../lib/i18n.js';

const CAP = {
  process: t('运行外部程序'),
  network: t('访问网络'),
  files: t('读写服务器上的文件'),
  env: t('读环境变量（可能含密钥）'),
  core: t('调用 bridge 内部模块'),
};
export const capText = (c) => CAP[c] || tr(String(c));
export const joinList = (xs) => xs.join(isEn() ? ', ' : '、');
export const capsText = (caps) => (Array.isArray(caps) && caps.length ? joinList(caps.map(capText)) : '');
export const kindText = (k) => (k === 'server' ? t('含服务端代码') : t('纯页面'));
export const isCommunity = (x) => x?.channel === 'community';
// login 来自签名索引 / GitHub，本身就是合法的用户名字符；编码只防万一
export const githubUser = (login) => 'https://github.com/' + encodeURIComponent(String(login || ''));

// 已装插件的来源：社区装的写作者，官方装的照旧「插件市场」
export const marketSource = (p) => (p?.market?.market === 'community'
  ? (p.market.publisher ? t('社区 · @{login}', { login: p.market.publisher }) : t('社区'))
  : t('插件市场'));
// 当前这一版被社区市场下架了（换成没下架的版本后服务端会清掉，所以要比对版本）
export const revokedOf = (p) => (p?.market?.market === 'community' && p.market.revoked && p.market.revoked.version === p.version ? p.market.revoked : null);
// 从市场装来的（官方的、或社区里别人发的）不给发：作者发新版应从自己的开发目录或自己上传的包发，装来的那份归属对不上，检查必不过
export const canPublish = (p) => !!p && ((p.source === 'installed' && !p.market) || p.source === 'local');

const sentence = (s) => { const x = String(s || '').trim(); return /[。.!！?？]$/.test(x) ? x : x + (isEn() ? '.' : '。'); };

/**
 * 社区插件装 / 更新 / 换版本前的确认框参数（交给功能扩展页的 confirm）。
 * 纯页面：普通确认——它只在不透明源沙箱里跑，对话与文件还要逐项同意；
 * 含服务端代码：danger 确认，写清作者与检测到的能力——它以 bridge 全部权限在服务器上跑，没人审过。
 */
export function communityConfirm({ name, v, publisher, kind, caps = [], notes = '', restart = false, has = false, down = false }) {
  const server = kind === 'server';
  const title = !has ? t('安装社区插件「{name}」v{v}？', { name, v })
    : down ? t('把「{name}」降到 v{v}？', { name, v }) : t('把「{name}」更新到 v{v}？', { name, v });
  const who = publisher ? t('作者 @{login}。', { login: publisher }) : '';
  const risk = server
    ? [capsText(caps) ? t('含服务端代码，检测到的能力：{caps}。', { caps: capsText(caps) }) : t('含服务端代码，没检测到特别的能力。'),
      t('没有人工审核；它会以 bridge 的全部权限在这台服务器上运行，能读写服务器上的文件、用你的账号。只装你信得过的作者的插件。')]
    : [t('社区插件没有人工审核。它只在沙箱页面里运行，用到对话或文件时还会单独问你。')];
  const desc = [who, ...risk, notes ? t('这一版：{notes}', { notes: sentence(tr(notes)) }) : '', has ? t('旧版留在回收区，可以随时回退。') : '', restart ? t('要重启 bridge 才生效。') : '']
    .filter(Boolean).join(' ');
  const yes = server
    ? (!has ? t('我了解风险，安装') : down ? t('我了解风险，降级') : t('我了解风险，更新'))
    : (!has ? t('安装') : down ? t('降级') : t('更新'));
  return { title, desc, yes, danger: server };
}

// 服务端 428 needAck 带回的风险信息 → 同一套确认（前端已带 ack 时一般碰不到，索引中途变了才会）
export const ackConfirm = (a, { has = false, down = false } = {}) =>
  communityConfirm({ name: tr(a.name || a.id), v: a.version, publisher: a.publisher, kind: a.kind || 'server', caps: a.caps || [], has, down });

// 投稿状态（GET /api/plugins/community/submission）
export const SUB_TEXT = {
  checking: t('检查中'),
  failed: t('没通过'),
  merged: t('已合并，等上架'),
  live: t('已上架'),
  closed: t('拉取请求已关闭'),
  unknown: t('暂时查不到状态'),
};
export const subDone = (s) => s === 'live' || s === 'failed' || s === 'closed';
