// 桌面设置 › 反馈：一张信纸 + 附件；去向（是否同时发给 bridge 开发者）的开关与提示。
import { untrack } from 'svelte';
import { me } from '../../lib/state.svelte.js';
import { t, tr } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { filesFromInput, uploadAttachment } from '../../lib/attachments.js';
import { compressImage } from '../../lib/settings/common.js';
import { createFeedbackUpstream } from '../../lib/settings/common.svelte.js';

export function createDeskFeedback(D) {
  // ═══ 帮助 · 反馈 ═══
  let fbText = $state(''), fbBusy = $state(false), fbDone = $state(false), fbErr = $state('');
  let fbAtts = $state([]), fbFileInput = $state();
  async function onFbFiles(e) {
    const files = filesFromInput(e);
    for (const raw of files) {
      const isImg = (raw.type || '').startsWith('image/'), isVid = (raw.type || '').startsWith('video/');
      if (!isImg && !isVid) { fbErr = t('只能加图片或视频'); continue; }
      const f = isImg ? await compressImage(raw) : raw;
      await uploadAttachment(fbAtts, f, {
        draft: { name: f.name, kind: isImg ? 'image' : 'video', path: null, pending: true },
        upload: (file) => api.uploadBlob(file.name, file),
        onError: () => { fbErr = t('上传失败：{name}', { name: raw.name }); },
      });
    }
  }
  async function submitFeedback() {
    if (fbAtts.some((a) => a.pending)) { fbErr = t('附件还在上传…'); return; }
    const text = fbText.trim();
    if (!text && !fbAtts.length) { fbErr = t('写点什么、或加个图片/视频吧'); return; }
    fbBusy = true; fbErr = '';
    try {
      const attachments = fbAtts.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, kind: a.kind }));
      // shareWithDeveloper：提交的人自己勾了「这条也发给 bridge 开发者」才带 true，服务端才推（没带的只落本机）
      const r = await api.post('/api/feedback', { text, screen: 'settings-desktop', attachments, shareWithDeveloper: up.fbUp?.mode === 'push' && fbConsent === true });
      if (r && r.ok === false) throw new Error(r.error || 'fail');
      fbDone = true; fbText = ''; fbAtts = []; fbConsent = false;   // 同意只对这一条：下一条重新问
    } catch (e) { fbErr = t('提交失败：{reason}', { reason: tr(e?.body?.error || e?.message) || t('连不上服务器') }); }
    finally { fbBusy = false; }
  }
  // 反馈去向（/api/feedback/upstream）：默认只留在这台服务器上。管理员在这里主动打开「把用户反馈同时发给 bridge 开发者」
  // （默认关）之后，提交的人还要自己勾「这条也发给 bridge 开发者」（fbConsent，默认不勾、每条提交完复位）才发。
  // 没配中继地址（reason=no-relay）、不是正式实例时不出开关；开发者自己那台（mode=inbox）是汇总端，不出提示也不出开关。
  const up = createFeedbackUpstream();   // 去向开关与提示文案：两套外壳共用（lib/settings/common.svelte.js）
  let fbConsent = $state(false);
  // 打开设置就取一次（设置搜索按它决定出不出「同时发给 bridge 开发者」），进反馈页再刷新
  $effect(() => { const s = D.sec, k = me.kind; untrack(() => { if (k !== 'none' && (s === 'help' || !up.fbUp)) up.loadFbUp(); }); });
  function onFbUp(v) { return up.setFbUp(v, (m) => { fbErr = m; }); }
  return {
    get fbText() { return fbText; }, set fbText(v) { fbText = v; }, get fbBusy() { return fbBusy; }, get fbDone() { return fbDone; }, get fbErr() { return fbErr; },
    get fbAtts() { return fbAtts; }, set fbAtts(v) { fbAtts = v; }, get fbFileInput() { return fbFileInput; }, set fbFileInput(v) { fbFileInput = v; },
    onFbFiles, submitFeedback,
    get fbUp() { return up.fbUp; }, get fbUpBusy() { return up.fbUpBusy; }, get fbConsent() { return fbConsent; }, set fbConsent(v) { fbConsent = v; },
    get fbDest() { return up.fbDest; }, onFbUp, get fbUpNote() { return up.fbUpNote; }, get fbUpAdminSub() { return up.fbUpAdminSub; }, get fbInboxLine() { return up.fbInboxLine; },
  };
}
