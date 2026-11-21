// 「发送给 AI」的状态与流程：工作空间两套界面（手机 FilesPanel / 电脑 FilesDesktop）共用一份，各自只画自己的弹层。
// 菜单两层（Claude / Media Studio→创作页）；对话类目标（Claude）先进「选择对话」层（微信「选择聊天」式：新对话 / 历史会话列表 + 搜索）。
// 素材怎么备（服务端零拷贝 / 手机本地现传 / 这台电脑现读现传）各界面不同，由构造参数 material / readText 交进来。
import { compose, studioInbox, session, agentOn, screenOn, ui } from '../state.svelte.js';
import { api } from '../api.js';
import { getCachedSessions } from '../cache.js';
import { titleFor } from '../library.svelte.js';
import { openSession, newConversation } from '../chat.svelte.js';
import { ensureModule, mods } from '../../modules/services.svelte.js';
import { t, tr } from '../i18n.js';
import { fileAiCapabilities, filterAiSessions, loadAiSessions, sendFileToAi } from '../files-business.js';

export class AiSend {
  item = $state(null);       // 要发送的那一项；null＝弹层没开
  view = $state('root');     // 菜单层级：root（Claude / Media Studio）/ studio（创作页）/ video（这张图用作）/ chat（选择对话）
  chat = $state(null);       // 「选择对话」层：{ target, from, sessions, loading, q }
  #o;

  /** @param {{ kindOf: (name: string) => string, material: Function, readText: Function, toast: (m: string) => void }} o */
  constructor(o) { this.#o = o; }

  // 能力判定：文件类型决定能投给哪些页（图片当改图素材 / 视频帧，文本当提示词），
  // 再与这个身份能不能进 Media Studio 取交集（服务端下发的 me.agents）。
  caps = $derived.by(() => {
    const c = fileAiCapabilities(this.item, this.#o.kindOf);
    const g = screenOn('studio');
    return { ...c, claude: agentOn('claude'), agy: agentOn('agy'), studio: g && (c.video || c.image || c.audio || c.music), video: c.video && g, image: c.image && g, audio: c.audio && g, music: c.music && g };
  });

  open(item) { this.item = item; this.view = 'root'; this.chat = null; }
  close() { this.item = null; this.view = 'root'; this.chat = null; }

  pick(target) {
    if (target === 'claude' || target === 'agy') { this.openChatPick(target); return; }   // 对话类：先选会话再投递
    const it = this.item; this.close();
    if (it) this.send(it, target);
  }
  pickVideoSlot(slot) { const it = this.item; this.close(); if (it) this.send(it, 'video', slot); }

  // 列表本地缓存先出（Claude 有 IndexedDB 快照秒开），网络刷新殿后。
  async openChatPick(target) {
    this.chat = { target, from: this.view, sessions: [], loading: true, q: '' };
    this.view = 'chat';
    const st = this.chat;   // 代理引用：用户退出/重进后 chat 换了对象，旧请求返回即作废
    const agyMod = target === 'agy' ? await ensureModule('agy') : null;
    await loadAiSessions(target, {
      cached: () => (target === 'agy' ? (agyMod?.agyFileTarget?.cachedSessions() || []) : getCachedSessions()),
      remote: () => (target === 'agy' ? (agyMod?.agyFileTarget?.remoteSessions() || { sessions: [] }) : api.sessions()),
      current: () => this.chat === st,
      onCached: (sessions) => { st.sessions = sessions; },
      onDone: (sessions) => { if (sessions) st.sessions = sessions; st.loading = false; },
    });
  }
  chatBack() { this.view = this.chat?.from || 'root'; this.chat = null; }
  pickChat(sel) {   // sel: 'new' | 会话 id
    const it = this.item, tg = this.chat?.target;
    this.close();
    if (it && tg) this.send(it, tg, undefined, sel);
  }
  chatTitle = (s) => tr(this.chat?.target === 'claude' ? titleFor(s.id, s.title) : s.title) || t('（无标题）');   // 服务端占位标题（「（进行中…）」「(无标题)」）走 tr
  cur = $derived(
    this.chat?.target === 'claude'
      ? session.id
      : (this.chat?.target === 'agy' ? (mods.agy?.agyFileTarget?.current?.() || null) : null)
  );
  filtered = $derived.by(() => {
    if (!this.chat) return [];
    return filterAiSessions(this.chat.sessions, this.chat.q, this.chatTitle);
  });

  async send(item, target, slot, sess) {
    const agyMod = target === 'agy' ? await ensureModule('agy') : null;
    await sendFileToAi(item, target, slot, sess, {
      kindOf: this.#o.kindOf,
      material: this.#o.material,
      readText: this.#o.readText,
      toast: this.#o.toast,
      chats: {
        claude: {
          current: () => session.id,
          newChat: newConversation,
          load: openSession,
          attach: (attachment) => compose.attachments.push(attachment),
        },
        ...(agyMod?.agyFileTarget ? { agy: agyMod.agyFileTarget } : {}),
      },
      studio: { push: (it) => studioInbox.items.push(it) },
      navigate: (screen) => { ui.screen = screen; },
    });
  }
}
