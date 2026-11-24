// Claude 页右侧的「Antigravity 对话预览栏」：只读看一个 agy 会话，也能以你的名义给它发一句。
// 只用核心的通道（不引 lib/agy/：那是 agy 扩展的代码，核心静态 / 动态引它都会把扩展拖进主包）：
//   读转录   GET  /api/agy/session/:id（在跑时不含这一轮）+ /api/agy/active?session=
//   看直播   lib/sse.js resumeActive（scope:'agy'，点名会话）——attach 事件补上这一轮的用户那句，再重放缓冲
//   发消息   空闲：startChat（POST /api/chat，agent:'agy'）；在跑：POST /api/chat { steer:true } 插进这一轮
//   增量     总线 agy.run（开跑 / 收尾）、agy.bg_update（后台唤醒收尾）
// 和 Antigravity 分页自己的会话视图（lib/agy/store）互不相干：各挂各的流，服务端按会话缓冲，谁挂都行。
import { api } from '../api.js';
import { busOn } from '../bus.js';
import { startChat, resumeActive } from '../sse.js';
import { showToast } from '../toast.svelte.js';
import { t, tr } from '../i18n.js';
import { turnsFromHistory, applyEvent } from './agyPeekView.js';

/** open：开着；sid：会话；path：从哪个共用文件夹点开的（「在 Antigravity 打开」带给 openTarget）；cwd：会话目录（转录给的）。 */
export const agyPeek = $state({
  open: false, sid: '', title: '', path: '', cwd: '', plugin: '',
  turns: [], live: false, loading: false, error: '', sending: false,
});

let seq = 0;             // 换会话 / 关掉就作废在途的加载与流回调
let handle = null;       // 当前挂着的流（resumeActive / startChat）
let busOff = null;
let reloadT = 0;

const errText = (e) => tr(e?.body?.error || e?.message || '');

function stopStream() { try { handle?.stop(); } catch {} handle = null; }

function watchBus() {
  if (busOff) return;
  busOff = busOn((ev) => {
    if (!agyPeek.open || !ev || ev.sessionId !== agyPeek.sid) return;
    if (ev.type === 'agy.run') {
      if (ev.live) { agyPeek.live = true; if (!handle) attach(seq); }
      else if (!handle) reloadSoon();
    } else if (ev.type === 'agy.bg_update' && !handle) reloadSoon();
  });
}

function reloadSoon(ms = 300) {
  clearTimeout(reloadT);
  const my = seq;
  reloadT = setTimeout(() => { if (my === seq) load(my, { quiet: true }); }, ms);
}

// 挂着预览栏的页面数（ClaudePage 挂 AgyPeek 时登记）。独立页面 / 分屏那一格没挂它，点了就直接跳到 agy 页的那个会话。
let hosts = 0;
export function registerAgyPeekHost() { hosts++; return () => { hosts = Math.max(0, hosts - 1); }; }

/** 打开预览栏：{ id, title?, path?, plugin? }。同一个会话再点一次只是确保开着。 */
export function openAgyPeek({ id, title = '', path = '', plugin = '' } = {}) {
  const sid = String(id || '');
  if (!sid) return;
  if (!hosts) {
    import('../pluginUi.svelte.js').then(({ openTarget }) => openTarget({ session: { agent: 'agy', id: sid } }, { plugin: String(plugin || ''), path: String(path || ''), agent: 'claude' })).catch(() => {});
    return;
  }
  watchBus();
  if (agyPeek.open && agyPeek.sid === sid) return;
  stopStream();
  const my = ++seq;
  Object.assign(agyPeek, { open: true, sid, title: String(title || ''), path: String(path || ''), cwd: '', plugin: String(plugin || ''), turns: [], live: false, error: '', sending: false });
  load(my);
}

export function closeAgyPeek() {
  seq++;
  clearTimeout(reloadT);
  stopStream();
  agyPeek.open = false;
  agyPeek.live = false;
  agyPeek.sending = false;
}

async function load(my, { quiet = false } = {}) {
  if (!quiet) agyPeek.loading = true;
  agyPeek.error = '';
  try {
    const sid = agyPeek.sid;
    const [act, detail] = await Promise.all([
      api.get('/api/agy/active?session=' + encodeURIComponent(sid)).catch(() => null),
      api.get('/api/agy/session/' + encodeURIComponent(sid) + (agyPeek.cwd ? '?cwd=' + encodeURIComponent(agyPeek.cwd) : '')).catch((e) => {
        // 旧服务端对在跑的会话回 409：没有历史，只挂直播
        if (e?.status === 409) return null;
        throw e;
      }),
    ]);
    if (my !== seq) return;
    const liveNow = !!(act?.active && act.sessionId === sid);
    if (detail) {
      agyPeek.turns = turnsFromHistory(detail.messages);
      agyPeek.title = detail.customTitle || detail.title || agyPeek.title;
      agyPeek.cwd = detail.cwd || act?.cwd || agyPeek.cwd;
    } else if (act?.cwd) agyPeek.cwd = act.cwd;
    // 拿到的不是完整历史（这一轮还在跑）：挂上直播把这一轮接在后面
    agyPeek.live = liveNow || !!detail?.live;
    if ((liveNow || !detail || detail.live) && !handle) attach(my);
  } catch (e) {
    if (my === seq) agyPeek.error = errText(e) || t('加载对话失败');
  } finally {
    if (my === seq) agyPeek.loading = false;
  }
}

// 这一轮收尾（done / interrupted / error 事件）：放下流，过一会儿重读转录对齐（磁盘上的才是定稿）
function turnEnded() {
  try { handle?.stop(); } catch {}
  handle = null;
  agyPeek.live = false;
  reloadSoon(600);
}

async function attach(my) {
  if (handle) return;
  const sid = agyPeek.sid;
  const h = await resumeActive({
    onEvent: (ev) => { if (my === seq && applyEvent(agyPeek.turns, ev)) turnEnded(); },
    onError: () => { if (my === seq) { handle = null; reloadSoon(0); } },
    onEnded: () => { if (my === seq) { handle = null; agyPeek.live = false; reloadSoon(0); } },
  }, { scope: 'agy', session: sid });
  if (my !== seq) { try { h?.stop(); } catch {} return; }
  if (h) { handle = h; agyPeek.live = true; return; }
  // 探的时候在跑、挂上去时已经结束：重读一次完整历史
  agyPeek.live = false;
  reloadSoon(0);
}

/** 以你的名义给这个会话发一句。在跑时插进这一轮（它做完手头这一步就读到），空闲时开一轮。→ 发出去了 true。 */
export async function sendAgyPeek(rawText) {
  const text = String(rawText || '').trim();
  const sid = agyPeek.sid;
  if (!text || !sid || agyPeek.sending) return false;
  const my = seq;
  agyPeek.sending = true;
  try {
    if (agyPeek.live) {
      const res = await api.post('/api/chat', { agent: 'agy', message: text, sessionId: sid, client: 'web', steer: true });
      if (my !== seq) return true;
      agyPeek.turns.push({ role: 'user', text, mine: true });
      if (res?.queued) showToast(t('这一轮正在收尾，这句排在后面，收尾后发出'));
      else if (res?.started && !handle) attach(my);
      return true;
    }
    agyPeek.turns.push({ role: 'user', text, mine: true });
    agyPeek.turns.push({ role: 'assistant', status: 'streaming', blocks: [] });
    agyPeek.live = true;
    stopStream();
    handle = startChat({ agent: 'agy', message: text, sessionId: sid, client: 'web' }, {
      onEvent: (ev) => { if (my === seq && applyEvent(agyPeek.turns, ev)) turnEnded(); },
      onError: (e) => {
        if (my !== seq) return;
        handle = null;
        agyPeek.live = false;
        showToast(errText(e) || t('没能送达，再发一次试试'), 'err');
        reloadSoon(0);
      },
      onEnded: () => { if (my === seq) { handle = null; agyPeek.live = false; reloadSoon(0); } },
    }, { scope: 'agy' });
    return true;
  } catch (e) {
    if (my === seq) showToast(errText(e) || t('没能送达，再发一次试试'), 'err');
    return false;
  } finally {
    if (my === seq) agyPeek.sending = false;
  }
}
