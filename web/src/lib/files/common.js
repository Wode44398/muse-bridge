// 工作空间两套界面（手机 FilesPanel / 电脑 FilesDesktop）共用的小件：短类型码、大小格式、查看器条目键、拖入判定、分享链接铸造。
import { kindOf as fkKind, iconKindOf, extOf } from '../fileKinds.js';
import { t, tr } from '../i18n.js';
import { shareRequest, shareResult } from '../files-business.js';

// 列表里沿用的短类型码（图标配色 / 简介与类型列文案 / 传输行字形 / 发送给 AI 的能力判断 / 解压入口）：判定全部来自 lib/fileKinds.js 单一词表
const KIND_CODE = { image: 'img', video: 'mov', audio: 'audio', pdf: 'pdf', markdown: 'md', html: 'html', text: 'text' };
export function kindOf(name) {
  const k = KIND_CODE[fkKind(name)];
  if (k) return k;
  const ik = iconKindOf(name);
  return ik === 'zip' ? 'zip' : extOf(name) === 'apk' ? 'apk' : 'doc';
}

export function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// 「换一种方式看」（svg ↔ 源码）会在查看器条目的 key 后面挂 #view:…，按原 key 找回列表项
export const baseKey = (k) => String(k || '').replace(/#view:[^#]*$/, '');

export const dtHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

// 「分享链接」：文件和文件夹一律走 /api/share-space 拷成只读分享空间出 /w/<token>（单文件就是「只有一个文件的空间」）。
// d 是弹窗状态 { item, pwOn, password, ttl, busy, result }；root＝服务端摸这份文件用的 ws 作用域。api 由调用方交进来（同 files-business.js 的 runCompress），本文件不连带加载网络层。
export const newShareDialog = (item) => ({ item, pwOn: false, password: '', ttl: 24, busy: false, result: null });
export async function mintShareLink(api, d, rel, root, toast) {
  if (!d || d.busy) return;
  const request = shareRequest(d);
  if (request.error) { toast(tr(request.error)); return; }
  d.busy = true;
  try {
    const r = await api.shareSpaceMint([rel], request.options, root);
    // 未配公网域名时后端 url 为空 → 用当前源拼（同源可用；隧道/局域网访客按访问源）。
    d.result = shareResult(r, request.password);
  } catch (e) { toast(t('创建分享失败：{reason}', { reason: tr(e.body?.error || e.body || e.message || '') })); }
  d.busy = false;
}
