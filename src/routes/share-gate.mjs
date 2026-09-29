// 分享密码闸——share.mjs（/s/ 单文件直链）与 share-space.mjs（/w/ 分享空间）共用。
// 模型：铸链时若带 password，存 {pwSalt, pwHash(scrypt), unlock(随机凭证)}；访问方在
// 密码页 POST /api/share-unlock 验对密码换取 unlock 凭证 k，之后凭 ?k=<unlock> 放行
// （密码本身绝不进 URL，进 URL 的只是跟 token 同级的随机能力串）。
// 本模块只放纯函数 + 密码页模板 + 防爆破限速，不碰两边的 store，避免循环依赖。

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

// 铸链时调用：密码 → 存进分享记录的三个字段。
export async function makePwRec(password) {
  const pwSalt = crypto.randomBytes(8).toString('hex');
  const pwHash = (await scryptAsync(String(password), pwSalt, 32)).toString('hex');
  const unlock = crypto.randomBytes(12).toString('base64url');   // 验对密码后发放的访问凭证
  return { pwSalt, pwHash, unlock };
}

// 记录 + 明文密码 → 是否正确（timingSafeEqual 防时序侧信道）。
export async function checkPw(rec, password) {
  try {
    const h = await scryptAsync(String(password), rec.pwSalt, 32);
    return crypto.timingSafeEqual(h, Buffer.from(rec.pwHash, 'hex'));
  } catch { return false; }
}

// 防爆破：每 token 10 分钟窗口内最多 30 次尝试（内存态，重启清零即可）。
const attempts = new Map();
const MAX_ATTEMPT_KEYS = 2048;
function pruneAttempts(now) {
  for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
  while (attempts.size >= MAX_ATTEMPT_KEYS) attempts.delete(attempts.keys().next().value);
}
export function allowAttempt(token) {
  const now = Date.now();
  let a = attempts.get(token);
  if (!a || now > a.resetAt) {
    pruneAttempts(now);
    a = { n: 0, resetAt: now + 10 * 60e3 };
    attempts.set(token, a);
  }
  return ++a.n <= 30;
}
export function clearAttempts(token) { attempts.delete(token); }

// —— 访客页外壳（密码页 / 失效页）——
// 与前端 SharePage 同一套视觉令牌：暖白底 + 白卡片 + 陶土色强调，跟随系统明暗。
// 这两页不走 SPA 包，纯内联、零外链；/s/ 与 /w/ 共用。
const SHELL_CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d1c1a;--ink2:#6f6d66;--ink3:#9a978e;--line:rgba(29,28,26,.1);--field:rgba(29,28,26,.04);--accent:#c96442;--accent-soft:rgba(201,100,66,.12);--danger:#d1453b;--shadow:0 1px 2px rgba(29,28,26,.04),0 10px 30px rgba(29,28,26,.07);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--card:#252524;--ink:#f3f2ed;--ink2:#a9a79f;--ink3:#7c7a73;--line:rgba(255,255,255,.1);--field:rgba(255,255,255,.05);--accent:#d97757;--accent-soft:rgba(217,119,87,.16);--danger:#ff6b61;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.28)}}
*{box-sizing:border-box;margin:0}
html,body{min-height:100%}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;padding:24px 16px calc(24px + env(safe-area-inset-bottom,0px));background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.card{width:100%;max-width:360px;padding:32px 24px 24px;border-radius:20px;background:var(--card);box-shadow:var(--shadow);text-align:center}
.badge{display:grid;place-items:center;width:56px;height:56px;margin:0 auto 18px;border-radius:16px;background:var(--accent-soft);color:var(--accent)}
.badge.muted{background:var(--field);color:var(--ink2)}
.badge svg{width:26px;height:26px}
h1{font-size:19px;font-weight:600;line-height:1.35}
.sub{margin-top:8px;font-size:14px;line-height:1.65;color:var(--ink2)}
form{display:flex;flex-direction:column;gap:10px;margin-top:22px}
input{width:100%;height:48px;padding:0 14px;border:1px solid var(--line);border-radius:12px;outline:none;background:var(--field);color:var(--ink);font:inherit;font-size:16px;text-align:center;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:var(--ink3)}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input.bad{border-color:var(--danger);animation:shake .32s}
button{height:48px;border:none;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-size:16px;font-weight:600;cursor:pointer;transition:filter .15s,opacity .15s}
button:hover{filter:brightness(1.06)}
button:active{filter:brightness(.94)}
button:disabled{opacity:.6;cursor:default;filter:none}
.err{min-height:20px;margin-top:12px;font-size:13px;line-height:20px;color:var(--danger)}
.foot{margin-top:20px;font-size:12px;color:var(--ink3)}
@keyframes shake{20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
@media (prefers-reduced-motion:reduce){input.bad{animation:none}}
`;
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2"/></svg>';
const GONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m3 3 18 18"/></svg>';

// 访客页语言（share / share-space / chat-snapshot / preview-host / site 共用）：默认中文，输出与改动前逐字节相同。
// 访客没有登录态、也拿不到 SPA 里的语言偏好，只能看地址与浏览器语言：
//   ?lang=en / ?lang=zh 显式指定（同 SPA 的调试参数）> Accept-Language 里一个 zh 标签都没有 → 英文 > 其余（含缺省请求头）→ 中文。
// 只要浏览器语言列表里有中文就出中文——系统是英文但也读中文的人（比如 en-US 的 Windows）不会被突然切成英文。
export function pageLang(req) {
  const q = /[?&]lang=(zh|en)(?=&|#|$)/.exec(String(req?.url || ''));
  if (q) return q[1];
  const al = String(req?.headers?.['accept-language'] || '').trim();
  return al && !/(^|,)\s*zh(?![a-z])/i.test(al) ? 'en' : 'zh';
}
// 页面文案两份。值里不能有直引号 '（会被拼进下面 <script> 的单引号字符串）。
const PAGE_TEXT = {
  zh: {
    html: 'zh-CN', foot: '文件分享',
    goneTitle: '分享已失效', goneH1: '链接已失效', goneFile: '下载链接', goneSpace: '分享',
    goneSub: (what) => `这个${what}不存在或已经过期。<br>如需继续访问，请联系分享者重新分享。`,
    gateTitle: '输入访问密码', gateSub: '这个分享设置了密码，输入后即可查看', pw: '访问密码', go: '查看分享',
    checking: '验证中…', tooMany: '尝试次数太多，请 10 分钟后再试', wrong: '密码不正确，请重新输入', net: '网络异常，请稍后重试',
  },
  en: {
    html: 'en', foot: 'File sharing',
    goneTitle: 'Link expired', goneH1: 'Link expired', goneFile: 'download link', goneSpace: 'share link',
    goneSub: (what) => `This ${what} doesn’t exist or has expired.<br>To access it again, ask the person who shared it for a new link.`,
    gateTitle: 'Enter password', gateSub: 'This share is password-protected. Enter the password to view it.', pw: 'Password', go: 'View',
    checking: 'Checking…', tooMany: 'Too many attempts. Try again in 10 min.', wrong: 'Incorrect password. Try again.', net: 'Can’t connect. Try again later.',
  },
};

function shell(title, inner, script = '', t = PAGE_TEXT.zh) {
  return `<!doctype html><html lang="${t.html}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<meta name="theme-color" content="#f6f5f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a1a19" media="(prefers-color-scheme: dark)">
<title>${title}</title><style>${SHELL_CSS}</style></head>
<body><main class="card">${inner}</main><p class="foot">The Bridge · ${t.foot}</p>${script}</body></html>`;
}

// 失效页：kind='file'（/s/ 下载链接）| 'space'（/w/ 分享空间）。lang 见 pageLang（缺省中文）。
export function goneHtml(kind = 'space', lang = 'zh') {
  const t = PAGE_TEXT[lang] || PAGE_TEXT.zh;
  const what = kind === 'file' ? t.goneFile : t.goneSpace;
  return shell(t.goneTitle, `<div class="badge muted">${GONE_SVG}</div>
<h1>${t.goneH1}</h1>
<p class="sub">${t.goneSub(what)}</p>`, '', t);
}

// 密码输入页。prefix = '/s/' 或 '/w/'；验对后跳 prefix+token?k=<unlock>。lang 见 pageLang（缺省中文）。
export function gateHtml(prefix, token, lang = 'zh') {
  const t = PAGE_TEXT[lang] || PAGE_TEXT.zh;
  const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');   // 内联进 <script>，防 </script> 截断（要输出 JSON 转义 \u003c 这 6 个字符，单反斜杠在 JS 字面量里就只是 <）
  return shell(t.gateTitle, `<div class="badge">${LOCK_SVG}</div>
<h1>${t.gateTitle}</h1>
<p class="sub">${t.gateSub}</p>
<form id="f" autocomplete="off" novalidate>
  <input id="pw" type="password" inputmode="text" enterkeyhint="go" placeholder="${t.pw}" aria-label="${t.pw}" maxlength="64" autofocus>
  <button id="go" type="submit">${t.go}</button>
</form>
<p id="err" class="err" role="alert" aria-live="polite"></p>`, `<script>
(function(){
  var token=${js(token)},prefix=${js(prefix)};
  var f=document.getElementById('f'),pw=document.getElementById('pw'),go=document.getElementById('go'),err=document.getElementById('err');
  function fail(m){err.textContent=m;pw.classList.remove('bad');void pw.offsetWidth;pw.classList.add('bad');go.disabled=false;go.textContent='${t.go}';pw.select();}
  pw.addEventListener('input',function(){if(err.textContent){err.textContent='';pw.classList.remove('bad');}});
  f.addEventListener('submit',async function(e){
    e.preventDefault();
    var v=pw.value; if(!v){pw.focus();return;}
    go.disabled=true; go.textContent='${t.checking}'; err.textContent='';
    try{
      var r=await fetch('/api/share-unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,password:v})});
      if(r.ok){var j=await r.json();location.replace(prefix+encodeURIComponent(token)+'?k='+encodeURIComponent(j.k)+location.hash);return;}
      fail(r.status===429?'${t.tooMany}':'${t.wrong}');
    }catch(_){fail('${t.net}');}
  });
  pw.focus();
})();
</script>`, t);
}
