// Muse Bridge 上的 bridge 反馈通道（/v1/cb/report 带 distro: 'muse'）→ Muse 的问题报告 → muse-bridge 仓库的公开 Issue。
//
// Muse Bridge 跑的是 bridge 公开版：网页「提交反馈」、以及网页里的 Claude 诊断后上报（agent 操作 feedback.report），
// 在管理员打开「把用户反馈同时发给 bridge 开发者」、提交人自己同意时，经 bridge 的推送通道发到本 Worker 的 /v1/cb/report。
// 带 distro: 'muse' 的那份不进 bridge 开发者的私有收件箱，在这里转成 Muse 原有的报告格式（deploy/muse/feedback/schema.mjs），
// 再走 Muse 那条路的限流、指纹查重、建 Issue（worker.mjs 的 submitMuse）。
//
// 转换规则：
//   · 网页里的 Claude 上报，正文第一行是「【经 Claude 诊断后上报】<标题>」→ kind=bug、source=claude，标题取那一行；
//     其余（网页「提交反馈」：问题、建议、吐槽分不出来）→ kind=feedback、source=web，标题取正文第一行。
//   · 正文已在 cleanCbReport 里按 Muse 的规则脱敏，cleanReport 再过一遍；界面位置、提交人角色、附件个数写在正文末尾。
//   · 图片不随 Issue 公开（GitHub 接口也没有给 Issue 传图的口子）：只记个数，图片留在提交那台服务器的反馈库里。
//   · 指纹 = 装机编号 + 正文的哈希：同一份反馈补发（bridge 那边超时重发）落到同一个 Issue 上，不会开出第二个；
//     不同服务器、不同正文互不相干（这类反馈没有程序报错的指纹可比，不做跨装机合并）。
import { cleanReport } from '../../deploy/muse/feedback/schema.mjs';
import { clip } from '../../deploy/muse/feedback/scrub.mjs';

// bridge 端 agent-api/ops/feedback.mjs 拼正文时的头一行前缀（改了这里跟着改；对不上就当普通网页反馈处理）
export const CLAUDE_MARK = '【经 Claude 诊断后上报】';

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** cleanCbReport 的产物 → cleanReport 的产物（格式不对时 cleanReport 抛错，调用方回 400） */
export async function museReportFromCb(cb) {
  let text = String(cb.text || '').trim();
  let kind = 'feedback', source = 'web', title = '';
  if (text.startsWith(CLAUDE_MARK)) {
    const nl = text.indexOf('\n');
    title = (nl < 0 ? text : text.slice(0, nl)).slice(CLAUDE_MARK.length).trim();
    text = nl < 0 ? '' : text.slice(nl + 1).trim();
    kind = 'bug'; source = 'claude';
  }
  const notes = [];
  if (cb.screen) notes.push(`Screen: ${cb.screen}`);
  if (cb.role) notes.push(`Submitted by ${cb.role === 'admin' ? 'the server admin' : 'a member'}`);
  const files = (cb.attachments?.length || 0) + (cb.omitted || 0);
  if (files) notes.push(`${files} attachment${files > 1 ? 's' : ''} kept on that server (images are not published in issues)`);
  // 正文上限 4000 字（cleanReport）：先给正文截好，末尾那行说明不被截掉
  const description = [clip(text, 3600), notes.length ? `(${notes.join(' · ')})` : ''].filter(Boolean).join('\n\n');
  const fp = (await sha256Hex(`cb\n${cb.install}\n${title}\n${text}`)).slice(0, 12);
  return cleanReport({
    v: 1, install: cb.install, kind, source, title, description, fp,
    lang: cb.lang || (/[一-鿿]/.test(text + title) ? 'zh' : 'en'),
    env: { version: cb.version, node: cb.node, os: cb.os, arch: cb.arch, uiLang: cb.lang },
  });
}
