// 停进程闸（A5-57，2026-11-08）：Claude 的 Bash / PowerShell（主聊天、子 agent、定时任务与插件代跑都过）里，
// 拒掉认不清归属的停进程写法——按端口停、按 node / python 这类共用的进程名停。
// 实例：测试服会话收尾时按 8791 端口查监听进程、再按映像名 python/node 过滤后 Stop-Process，一并停掉了
// E:\agent trading 监听 0.0.0.0:8791 的服务。Windows 允许一个进程监听 0.0.0.0:P 时另一个再绑 127.0.0.1:P，
// 「我的服务在这个端口起来了」不等于「这个端口上的进程都是我的」；查 PID 和停进程又写在同一条命令里，模型根本没看到停的是谁。
// auto 模式的分类器那次也放行了，所以这里在 bridge 侧补一道硬闸；软层是 claude.mjs 的 HOST_PROC_NUDGE。
//
// 规则（宁可漏拦，不可误拦：误拦让正常收尾多走一轮，漏拦靠提示词兜）：
//   ① 先把引号里的内容涂成空格（位置不变，grep -rn "taskkill|OwningProcess" 这类搜源码的不算）；双引号串里的 $( … ) 会执行，留着；
//      命令里套着 powershell -Command / bash -c / cmd /c 时整条不涂。adb shell / adb exec-out / hdc shell 后面那段在手机上执行，跳过。
//   ② 直接拒：按端口停的工具（kill-port、fkill、fuser -k）；按映像名停（taskkill /IM、Stop-Process -Name、Get-Process X | Stop-Process、
//      pkill、killall）而名字是共用运行时（node、python、浏览器、shell、docker…）、变量或宽通配符的。
//      停自家 app（taskkill /IM homepodcast.exe、Stop-Process -Name explorer）不拦：同名的只有它自己。
//   ③ 停进程的目标不是一眼可见的，而它前面（或参数里）有端口来源（OwningProcess、Get-NetTCPConnection、netstat、lsof、ss），拒；
//      有进程名来源（Get-Process <名>、按 Name 筛、pgrep、pidof、tasklist）且名字是共用运行时的，拒。端口只在停完之后查（看停干净没有）不算。
//      目标一眼可见 = 字面 PID（taskkill /PID 123 /T /F、Stop-Process -Id 1,2、Get-Process -Id 1,2 | Stop-Process、kill -9 123），
//      或本条命令里自己拿到的句柄（$p = Start-Process -PassThru …、PID=$!、kill %1、PID 文件里读出来的、字面 PID 列表 / 句柄的循环变量）。
//      来源之后按 CommandLine / ExecutablePath / 父进程核对过再停的，放行。
//   ③′ 端口来源的那一类钩子里再现场核查一次（killGuardCheck）：生产转录里这类拒了 130 条，几乎全是停自己起的 vite / 测试服。
//      先从来源里抽字面端口（-LocalPort 8791、:8791、findstr 8791、lsof -i :8791，foreach ($p in 8791, 8793) / for p in 8831 8832
//      这种字面循环变量也算；只给结果、没接给停进程的顶层查询不算来源），抽不全（变量、通配、来源里没写端口）维持拒。
//      再用 netstat -ano（非 Windows 用 lsof / ss）现场看这些端口，限时 2 秒，查不了、超时、看不到 PID 维持拒。
//      每个端口至多一个监听 PID、不是 bridge 自己或它的父 / 祖先，放行（可选 checkStart：早于本会话开始的也拒，默认关）；
//      同一端口两个以上 PID（A5-57 的双绑定）、是 bridge 自己 / 祖先、本会话之前就在跑的，拒，文案点名 PID、进程名和命令行，
//      让模型确认后按字面 PID 停。进程详情（Win32_Process）查不到只是不点名、不比起始时间，不因此拒。
//   ④ 字面 PID 是 bridge 服务进程自己的，拒。
// 现场核查放行也只是放行（{ continue: true }），后面的权限档 / 分类器照常把关。
// 只回 deny 或放行（{ continue: true }），绝不回 allow：auto 模式下钩子的 allow 会被转去分类器复核，替它担保不了什么；
// 在别的权限档里回 allow 反倒会越过审批卡。

import { execFile } from 'node:child_process';
import fs from 'node:fs';

const WIN = process.platform === 'win32';

// 停进程的动词（前面是命令边界才算；PowerShell 里 kill 是 Stop-Process 的别名）
const VERB = String.raw`(?:taskkill(?:\.exe)?|tskill|kill|pkill|killall|Stop-Process|spps)`;
const VERB_RE = new RegExp(String.raw`(?:^|[\s;&|({}\x60])${VERB}(?=[\s;&|)}\x60]|$)`, 'i');
const OBJ_KILL_RE = /\.(?:Kill|Terminate)\(|\bInvoke-CimMethod\b[^|;\n]*\bTerminate\b|\bRemove-CimInstance\b|\bwmic\b[^|;&\n]*\b(?:delete|terminate)\b/gi;
const PORT_TOOL_RE = /(?:^|[\s;&|(])(?:npx\s+)?(?:kill-port|fkill)(?=\s|$)|\bfuser\b[^|;&\n]*\s-k\b/i;
// 端口来源（引号也算边界：套娃命令不涂引号）
const PORT_SRC_RE = /\bOwningProcess\b|\bGet-Net(?:TCP|UDP)Connection\b|(?:^|[\s;&|(`$'"])(?:netstat|lsof|ss)(?=\s|$)/gi;
// 进程名来源只认「按名字列进程」：Get-Process <名>、列全部进程再按 Name 筛、pgrep / pidof / tasklist；
// 拿 PID 文件里的 PID 再核一眼 $p.ProcessName 的不算
const NAME_SRC_RE = /\b(?:Get-Process|gps)\s+(?:-Name\s+)?[A-Za-z*'"]|\b(?:Get-Process|gps|Get-CimInstance|gcim|Get-WmiObject|gwmi)\b(?:(?!\s-Id\b)[^|;\n])*\|\s*(?:Where-Object|where|\?)[^|\n]*?\b(?:Process)?Name\b|(?:^|[\s;&|(`$'"])(?:pgrep|pidof|tasklist)(?=[\s;&|)'"]|$)/gi;
// 在涂引号之前的原文上看：CIM / wmic 的过滤条件按映像名（-Filter "Name='node.exe'"、where name="node.exe"）
const RAW_NAME_FILTER_RE = /-Filter\s+["'][^"'\n]*\bName\s*(?:=|like\b)|\bwmic\b[^|;&\n]*\bwhere\b[^|;&\n]*\bname\s*(?:=|like\b)/gi;
// 核对过再停：CommandLine / ExecutablePath -like …、命令行列出来再 grep、只挑某个父进程的子进程
const NARROWED_RE = /\b(?:CommandLine|ExecutablePath)\b[^;\n]*?(?:\s-[ci]?(?:like|match|eq|contains)\b|\.(?:Contains|StartsWith|EndsWith|IndexOf)\()|\.Path\b[^;\n]*?\s-[ci]?(?:like|match|eq)\b|\bParentProcessId\b\s*-eq\b|\bCommandLine\b[^;\n]*\|\s*(?:grep|findstr|Select-String|sls)\b[^;\n]*?(?:\||&&)/gi;   // grep 完还往下喂（| awk、&&）才算筛过
const RAW_NARROWED_RE = /(?:-Filter|\bwhere)\s+["'][^\n]*?\b(?:commandline|executablepath)\s+like\b/gi;
// 命令行先存进变量再比：$c = (Get-CimInstance … ).CommandLine; if ($c -like '*server.mjs 8804*') {…}（或 $c.IndexOf('…')）
const NARROWED_VAR_RE = /\$(\w+)\s*=[^;\n]*\b(?:CommandLine|ExecutablePath)\b[^;\n]*[;\n][\s\S]*?\$\1\b(?:\s*-[ci]?(?:like|match|eq|contains)\b|\.(?:Contains|StartsWith|EndsWith|IndexOf)\()/gi;
const NESTED_RE = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n|;&]*?\s-c(?:ommand)?\b|\b(?:bash|sh|zsh)(?:\.exe)?\s+(?:-\w+\s+)*-\w*c\b|\bcmd(?:\.exe)?\s+(?:\/\w+\s+)*\/[ck]\b/i;
// 手机上执行的那段：adb [选项] shell … / adb exec-out … / hdc shell …，到本段结尾（引号里的分隔符不算）
const Q_OR = String.raw`(?:[^;&|\n"']|"[^"\n]*"|'[^'\n]*')`;
const PHONE_RE = new RegExp(String.raw`\b(?:adb|hdc)(?:\.exe)?\b${Q_OR}*?\s(?:shell|exec-out)\b${Q_OR}*`, 'gi');
// 直接当目标的 PID 文件：$(cat x.pid)、$(< x.pid)、$(cat x.pid 2>/dev/null)
const PIDFILE_RE = /\$\(\s*(?:cat\s+|<\s*)[^()\s;|&]+(?:\s+2>\s*[^()\s;|&]+)?\s*\)/g;

// 很多程序共用的进程名：按名字停会连带别人的（其它项目的服务、用户的浏览器、bridge 自己和它起的 CLI）
const SHARED_LIST = ['node', 'nodejs', 'python', 'pythonw', 'py', 'pyw', 'java', 'javaw', 'deno', 'bun', 'dotnet', 'ruby', 'php', 'perl',
  'cloudflared', 'workerd', 'wrangler', 'ngrok', 'nginx', 'httpd', 'caddy', 'redis-server', 'postgres', 'mysqld', 'mongod', 'ollama',
  'llama-server', 'uvicorn', 'gunicorn', 'msedge', 'msedgewebview2', 'chrome', 'chromium', 'firefox', 'electron', 'claude', 'codex',
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'conhost', 'wsl', 'wslhost', 'vmmem', 'docker', 'adb', 'git', 'ssh'];
const SHARED = String.raw`(?:node(?:js)?|python[\d.]*w?|pyw?|javaw?|deno|bun|dotnet|ruby|php(?:-cgi)?|perl|cloudflared|workerd|wrangler|ngrok|nginx|httpd|caddy|redis-server|postgres|mysqld|mongod|ollama|llama-server|uvicorn|gunicorn|msedge(?:webview2)?|chrome|chromium|firefox|electron|claude|codex|cmd|powershell|pwsh|bash|sh|conhost|wsl(?:host|service)?|vmmem\w*|docker|adb|git|ssh)`;   // 只认 docker CLI（多个会话各跑各的）；Docker Desktop / com.docker.backend 全机一份，按名字停的就是它自己
const SHARED_NAME_RE = new RegExp(String.raw`^${SHARED}(?:\.exe)?$`, 'i');
// 文里提到共用进程名（路径里的 \Claude\、node_modules、$node 变量不算）
const SHARED_WORD_RE = new RegExp(String.raw`(?<![\w\\/.$-])${SHARED}(?:\.exe)?(?![\w\\/-])`, 'i');

/** 映像名停的名字危险不危险：共用运行时、变量 / 算出来的、通配得太宽 */
function riskyName(n) {
  n = String(n).trim();
  if (!n || /[$%(@{]/.test(n)) return true;
  n = n.replace(/\.exe$/i, '');
  if (/[*?[]/.test(n)) {
    const core = n.replace(/[*?[\]]/g, '').toLowerCase();
    return core.length < 3 || SHARED_WORD_RE.test(core) || SHARED_LIST.some((s) => s.startsWith(core));
  }
  return SHARED_NAME_RE.test(n);
}

/** pkill / killall 的模式：pkill 按名字子串（-f 按整条命令行）正则匹配，killall 按名字精确匹配 */
function riskyPattern(p, exact) {
  p = String(p).trim();
  if (!p || /[$%`]/.test(p)) return true;
  if (exact) return riskyName(p);
  const core = p.replace(/[\^$.*+?()[\]{}|\\]/g, '').toLowerCase();
  return core.length < 3 || SHARED_WORD_RE.test(p) || SHARED_LIST.some((s) => s.includes(core));
}

/** 剥 heredoc 正文（cat > x.md <<'EOF' 写文档、写脚本）；喂给 shell 执行的（bash <<EOF、powershell -Command - <<EOF）留着，不加引号的分界符正文里带 $( 或反引号的也留着。 */
function stripHeredocs(c) {
  return c.replace(/^([^\n]*?<<-?\s*(['"]?)([\w.-]+)\2[^\n]*)\n([\s\S]*?)\n([ \t]*\3[ \t]*)(?=\n|$)/gm, (all, line, q, tag, body, end) => {
    if (/\b(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?\b/i.test(line)) return all;   // 含 cat <<EOF | bash
    if (!q && /\$\(|`/.test(body)) return all;
    return line + '\n' + end;
  });
}

/** 双引号串只留会执行的 $( … )（Bash 还有反引号），其余涂成空格；引号本身留着 */
function keepSubs(s, ps) {
  const out = new Array(s.length).fill(' ');
  out[0] = s[0]; out[s.length - 1] = s[s.length - 1];
  for (let i = 1; i < s.length - 1; i++) {
    if (ps && s[i] === '`') { i++; continue; }
    if (s[i] === '$' && s[i + 1] === '(') {
      let d = 0, j = i + 1;
      for (; j < s.length - 1; j++) { if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) break; }
      for (let k = i; k <= j && k < s.length - 1; k++) out[k] = s[k];
      i = j;
    } else if (!ps && s[i] === '`') {
      let j = s.indexOf('`', i + 1); if (j < 0 || j > s.length - 2) j = s.length - 2;
      for (let k = i; k <= j; k++) out[k] = s[k];
      i = j;
    }
  }
  return out.join('');
}

/** 涂掉引号内容（长度不变，位置和原文对得上）：Bash 双引号里 \ 转义；PowerShell 双引号里 ` 转义、"" 是一个引号。 */
function stripQuotes(c, ps) {
  // 一遍从左往右扫，谁先开头算谁（"it's" 里的单引号不会去配后面的引号）
  const re = ps ? /'[^']*'|"(?:[^"`]|`[\s\S]|"")*"/g : /'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g;
  return c.replace(re, (s) => {
    if (s[0] === "'" || !/\$\(|`/.test(ps ? s.replace(/`[\s\S]/g, '') : s)) return s[0] + ' '.repeat(s.length - 2) + s[0];
    return keepSubs(s, ps);
  });
}

/** 在 c 上找 re，c 和原文同一位置一起换成 repl（补空格到原长） */
function blankBoth(c, raw, re, repl) {
  let out = c, rawOut = raw;
  for (const m of c.matchAll(re)) {
    const r = repl.length <= m[0].length ? repl + ' '.repeat(m[0].length - repl.length) : m[0];
    out = out.slice(0, m.index) + r + out.slice(m.index + r.length);
    rawOut = rawOut.slice(0, m.index) + r + rawOut.slice(m.index + r.length);
  }
  return [out, rawOut];
}

const FILE_READ = String.raw`(?:Get-Content|gc|cat|type)\s`;
/**
 * 本条命令里自己拿到的句柄（小写，PowerShell 变量不分大小写）：Start-Process -PassThru / Process::Start 的返回、$! 、
 * 从 PID 文件读出来的（$id = [int](Get-Content x.pid)、PID=$(cat x.pid)、for p in $(cut -f1 pids.tsv)）、字面 PID 列表的循环变量，
 * 以及从句柄派生出来的（$id = [int]($l.Split('=')[1])、foreach ($id in $p.vite, $p.server)）。
 */
function ownHandles(c) {
  const h = new Set(['__pf']);
  const add = (re) => { for (const m of c.matchAll(re)) h.add(m[1].toLowerCase()); };
  add(new RegExp(String.raw`\$(\w+)\s*=\s*(?:\[int\]\s*)?[(\s]*${FILE_READ}`, 'gi'));
  add(/(?:^|[\s;&(])(?:local\s+|export\s+)?(\w+)=\$__pf\b/g);
  add(/\$(\w+)\s*=\s*(?:Start-Process|saps)\b[^;\n]*\s-PassThru\b/gi);
  add(/\$(\w+)\s*=\s*\[(?:System\.)?Diagnostics\.Process\]::Start\(/gi);
  add(/(?:^|[\s;&(])(?:local\s+|export\s+)?(\w+)=\$!/g);
  add(new RegExp(String.raw`\bforeach\s*\(\s*\$(\w+)\s+in\s+(?:\d+(?:\s*,\s*\d+)*\s*\)|\(?\s*${FILE_READ})`, 'gi'));
  add(/\bfor\s+(\w+)\s+in\s+\d+(?:\s+\d+)*\s*;/g);
  for (const m of c.matchAll(/\bfor\s+(\w+)\s+in\s+\$\(\s*((?:cat|cut|head|tail|awk|sed|tr)\s[^()]*)\)/g)) {
    if (!new RegExp(PORT_SRC_RE.source, 'i').test(m[2]) && !new RegExp(NAME_SRC_RE.source, 'i').test(m[2]) && !/\bps\b/.test(m[2])) h.add(m[1].toLowerCase());
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const m of c.matchAll(/\$(\w+)\s*\+?=\s*(?:\[int\]\s*)?[(@\s]*\$(\w+)\b/g)) if (h.has(m[2].toLowerCase())) h.add(m[1].toLowerCase());
    for (const m of c.matchAll(/\bforeach\s*\(\s*\$(\w+)\s+in\s+[(@\s]*\$(\w+)\b/gi)) if (h.has(m[2].toLowerCase())) h.add(m[1].toLowerCase());
    for (const m of c.matchAll(/\bfor\s+(\w+)\s+in\s+["']?\$\{?(\w+)\b/g)) if (h.has(m[2].toLowerCase())) h.add(m[1].toLowerCase());
  }
  return h;
}

// 一个目标写法是不是一眼可见：字面 PID、$! / %1、本条命令里的句柄（$p、$p.Id、${pid}、$c.ProcessId）
function plainTarget(t, handles) {
  if (/^\d+(?:,\d+)*$/.test(t) || t === '$!' || /^%\d+$/.test(t)) return true;
  const m = /^\$\{?(\w+)\}?(?:\.(?:Id|ProcessId|Pid))?$/i.exec(t);
  return !!(m && handles.has(m[1].toLowerCase()));
}

// 从 i 往后到这一句结尾（括号配平：kill $(lsof -ti:3000)、Stop-Process -Id (Get-NetTCPConnection …).OwningProcess 都算进来）
function stmtEnd(c, i) {
  let d = 0;
  for (; i < c.length; i++) {
    const ch = c[i];
    if (ch === '(' || ch === '{') d++;
    else if (ch === ')' || ch === '}') { if (--d < 0) return i; }
    else if (!d && (ch === ';' || ch === '\n' || ch === '|' || ch === '&')) return i;
  }
  return i;
}

// 原文参数切词：去掉重定向（>nul、2>&1、>/dev/null），引号当一个词，$ 前的 \（套娃命令里的 \$p）去掉
const rawToks = (s) => (s.replace(/(^|\s)\d*>>?\s*(?:&\d|\S+)/g, ' ').match(/"[^"]*"|'[^']*'|[^\s"']+/g) || [])
  .map((t) => t.replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/^\\(?=\$)/, '').trim()).filter(Boolean);

// -Id 1, 2 / -Name a, b 这种逗号后带空格的列表合回一个
function takeList(toks, i) {
  let v = toks[i];
  while (/,$/.test(v) && toks[i + 1]) v += toks[++i];
  while (toks[i + 1] && /^,/.test(toks[i + 1])) v += toks[++i];
  return [v, i];
}

const EA_FLAG = /^-(?:ErrorAction|EA)$/i, EA_INLINE = /^-(?:ErrorAction|EA):\w+$/i;

/** Get-Process … 管道喂给 Stop-Process 时：-Id 字面列表当目标，名字当映像名 */
function parseGps(toks) {
  const ids = [], names = [];
  let bad = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^-Id$/i.test(t) && toks[i + 1]) { const [v, j] = takeList(toks, i + 1); ids.push(v); i = j; }
    else if (/^-(?:Name|ProcessName)$/i.test(t) && toks[i + 1]) { const [v, j] = takeList(toks, i + 1); names.push(...v.split(',')); i = j; }
    else if (EA_FLAG.test(t) && toks[i + 1]) i++;
    else if (EA_INLINE.test(t)) continue;
    else if (!t.startsWith('-')) { const [v, j] = takeList(toks, i); names.push(...v.split(',')); i = j; }
    else bad = true;
  }
  return { ids, names, bad };
}

/**
 * 命令里每一处停进程：{ start, end, plain, pids, image, risky }。plain = 目标全都一眼可见；pids = 写出来的字面 PID；
 * image = 按映像名 / 模式停，risky = 名字是共用运行时（或变量、宽通配）。
 * 管道喂进来的 Stop-Process（前一段不是句柄或 Get-Process -Id 字面）、xargs kill、$(…) 算出来的目标都不算一眼可见。
 */
function killSites(c, raw, handles) {
  const sites = [];
  const re = new RegExp(String.raw`(^|[\s;&|({}\x60])(${VERB})(?=[\s;&|)}\x60]|$)((?:>&\d|[^;&|\n(){}\x60])*)`, 'gi');
  for (const m of c.matchAll(re)) {
    const verb = m[2].toLowerCase().replace(/\.exe$/, '');
    const start = m.index + m[1].length;
    const argEnd = m.index + m[0].length;
    const end = stmtEnd(c, argEnd);
    const lo = Math.max(0, start - 400);
    const before = c.slice(lo, start);
    let piped = null;
    if (/(?:^|[^|])\|\s*$/.test(before)) {
      const pe = lo + before.replace(/\|\s*$/, '').length;
      const ps = Math.max(...[';', '&', '|', '\n', '(', '{'].map((ch) => c.lastIndexOf(ch, pe - 1))) + 1;
      piped = { text: c.slice(ps, pe).trim(), raw: raw.slice(ps, pe).trim() };
    }
    const viaXargs = /\bxargs(?:\s+-\w+)*\s*$/.test(before);
    const toks = rawToks(raw.slice(start + m[2].length, argEnd));
    const pids = [], names = [];
    let targets = [], bad = viaXargs, image = false, risky = false;
    if (verb === 'taskkill') {
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i].toLowerCase();
        if ((t === '/pid' || t === '-pid') && toks[i + 1]) targets.push(toks[++i]);
        else if ((t === '/im' || t === '-im') && toks[i + 1]) names.push(toks[++i]);
        else if ((t === '/fi' || t === '-fi') && toks[i + 1]) {
          const f = toks[++i], im = /^IMAGENAME\s+eq\s+(\S+)$/i.exec(f.trim());
          names.push(im ? im[1] : '$filter');   // 按窗口标题 / 状态 / 用户筛的认不清，当危险
        } else if (!/^[/-](?:t|f)$/.test(t)) bad = true;
      }
    } else if (verb === 'kill' && !toks.some((t) => /^-(?:Id|InputObject|Name|ProcessName|Force|PassThru)$/i.test(t))) {
      // Bash 的 kill [-9 | -TERM | -s TERM | -n 9 | --] PID…（带 -Id / -Name / -Force 的是 PowerShell 别名，走下面 Stop-Process 那支）
      if (toks[0] === '-0' || toks[0] === '-l') continue;   // 探活 / 列信号，不停进程
      let i = 0;
      if ((toks[0] === '-s' || toks[0] === '-n') && toks[1]) i = 2;
      else if (/^-(?:\d+|[A-Z]+\d*)$/i.test(toks[0] || '') || toks[0] === '--') i = 1;
      targets = toks.slice(i);
    } else if (verb === 'tskill') {
      const t = toks.filter((x) => !/^\/\w+$/.test(x))[0];
      if (t && /^\d+$/.test(t)) targets.push(t); else names.push(t || '$');
    } else if (verb === 'pkill' || verb === 'killall') {
      let pat = null, full = false;
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t === '-f' || t === '--full' || /^-[a-zA-Z]*f$/.test(t) && verb === 'pkill') full = true;
        if (/^(?:-[sugGPtoy]|--signal|--user|--older-than|--younger-than)$/.test(t)) i++;
        else if (!t.startsWith('-') && pat === null) pat = t;
      }
      image = true;
      risky = riskyPattern(pat || '', verb === 'killall' && !full);
    } else if (verb === 'stop-process' || verb === 'spps' || verb === 'kill') {
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (/^-(?:Id|InputObject)$/i.test(t) && toks[i + 1]) { const [v, j] = takeList(toks, i + 1); targets.push(v); i = j; }
        else if (/^-(?:Name|ProcessName)$/i.test(t) && toks[i + 1]) { const [v, j] = takeList(toks, i + 1); names.push(...v.split(',')); i = j; }
        else if (/^-(?:Force|PassThru|WhatIf|Confirm(?::\$\w+)?)$/i.test(t)) continue;
        else if (EA_FLAG.test(t) && toks[i + 1]) i++;
        else if (EA_INLINE.test(t)) continue;
        else if (!t.startsWith('-') && !targets.length && !names.length) targets.push(t);   // 第 0 位就是 -Id
        else bad = true;
      }
      if (!targets.length && !names.length && piped) {
        const g = /^(?:Get-Process|gps)(?=\s|$)([\s\S]*)$/i.exec(piped.raw);
        if (g) {
          const r = parseGps(rawToks(g[1]));
          targets.push(...r.ids); names.push(...r.names); if (r.bad) bad = true;
          if (!r.ids.length && !r.names.length) names.push('*');   // Get-Process | Stop-Process：全停
        } else targets.push(piped.text);
      }
    } else bad = true;
    if (names.length) { image = true; risky = risky || names.some(riskyName); }
    if (!targets.length && !image) bad = true;
    for (const t of targets) {
      if (!plainTarget(t, handles)) bad = true;
      for (const n of t.split(',')) if (/^\d+$/.test(n)) pids.push(Number(n));
    }
    sites.push({ start, end, plain: !bad, pids, image, risky });
  }
  // $p.Kill() / CIM Terminate / wmic delete：只有句柄上的 .Kill() 算一眼可见
  for (const m of c.matchAll(OBJ_KILL_RE)) {
    const h = /\$(\w+)\s*$/.exec(c.slice(0, m.index));
    const start = m[0].startsWith('.') && h ? m.index - h[0].length : m.index;
    sites.push({ start, end: stmtEnd(c, m.index + m[0].length), plain: m[0].startsWith('.') && !!h && handles.has(h[1].toLowerCase()), pids: [], image: false, risky: false });
  }
  return sites;
}

// 来源 / 核对出现的位置；写在 done < <(…) / done <<< … 里的来源喂的是整个循环，记成 -1（在所有停进程之前）
function positions(text, re, useEnd) {
  const out = [];
  for (const m of text.matchAll(re)) {
    const lead = /^[\s;&|(`$'"]/.test(m[0]) ? 1 : 0;
    let at = useEnd ? m.index + m[0].length : m.index + lead;
    const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
    if (!useEnd && /\bdone\s*<{1,3}[^;\n]*$/.test(line)) at = -1;
    out.push(at);
  }
  return out;
}

// 拒绝文案要短：只说为什么没跑 + 两步正路（先查清是谁，再按字面 PID 停）
const LOOKUP = WIN ? 'Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select ProcessId,CreationDate,CommandLine' : 'ps -o pid,lstart,command -p <PID>';
const WAY = '改法：自己起的用 TaskStop 或启动时记下的 PID 停；否则先单独查出 PID，用 ' + LOOKUP + ' 确认是本会话起的，再按字面 PID 停。不是你的别动，端口被占就换端口。';
const REASON = {
  'port-tool': '没跑：kill-port / fkill / fuser -k 按端口停，不看是谁的进程，本机还有别的项目的服务。',
  image: '没跑：按 node、python、浏览器、shell 这类共用进程名（或变量、宽通配）停，会连带别人的同名进程。',
  port: '没跑：按端口查出 PID 就直接停，没看清是谁' + (WIN ? '（Windows 上 0.0.0.0 和 127.0.0.1 能各有一个进程占同一端口）' : '') + '，本机还有别的项目的服务。',
  name: '没跑：按 node、python 这类共用进程名查出 PID 就直接停，会连带别人的同名进程。',
};

/**
 * 这条命令能不能跑。返回 null（放行）或 { kind, reason }。
 * @param command  Bash / PowerShell 的 command
 * @param o        { shell: 'bash' | 'powershell'（决定双引号转义规则）, protectedPids: 不许停的 PID（bridge 服务自己） }
 */
export function killGuardVerdict(command, o = {}) {
  let raw = String(command ?? '').replace(/\/\//g, '/');   // Git Bash 的 taskkill //PID //F
  if (!raw.trim()) return null;
  const ps = o.shell === 'powershell';
  if (!ps && raw.includes('<<')) raw = stripHeredocs(raw);
  let c = NESTED_RE.test(raw) ? raw : stripQuotes(raw, ps);
  [c, raw] = blankBoth(c, raw, PHONE_RE, 'adb');
  [c, raw] = blankBoth(c, raw, PIDFILE_RE, '$__pf');
  if (!VERB_RE.test(c) && !new RegExp(OBJ_KILL_RE.source, 'i').test(c) && !PORT_TOOL_RE.test(c)) return null;
  const deny = (kind, reason) => ({ kind, reason: reason || REASON[kind] + WAY });
  if (PORT_TOOL_RE.test(c)) return deny('port-tool');
  const sites = killSites(c, raw, ownHandles(c));
  if (sites.some((s) => s.image && s.risky)) return deny('image');
  const guarded = new Set((o.protectedPids || []).filter((p) => Number.isInteger(p) && p > 0));
  for (const s of sites) for (const p of s.pids) {
    if (guarded.has(p)) return deny('self', `没跑：PID ${p} 是 bridge 服务本身（你就跑在它里面），停了所有会话一起断。要重启按维护者流程排延后重启。`);
  }
  const open = sites.filter((s) => !s.plain);
  if (!open.length) return null;
  const port = positions(c, PORT_SRC_RE);
  const name = [...positions(c, NAME_SRC_RE), ...positions(raw, RAW_NAME_FILTER_RE)];
  const narrow = [...positions(c, NARROWED_RE, true), ...positions(c, NARROWED_VAR_RE, true), ...positions(raw, RAW_NARROWED_RE, true)];
  let portHit = null;   // 按端口拒的那几处停进程：先记下，名字类的后面还要看（名字类没有现场核查，照拒）
  for (const s of open) {
    const p = port.filter((i) => i < s.end), n = name.filter((i) => i < s.end);
    if (!p.length && !n.length) continue;
    // 核对要发生在最后一个来源之后（来源只在参数里的，核对也得在这一句里）。$l.OwningProcess 这种只是读前面查好的变量，
    // 不算新来源（只有它的话从第一次读起算）；核对和来源写在同一个条件里（if (… -match … -and (Get-NetTCPConnection …))、
    // ? { … }，中间没有 ; 换行 { }）也算核对过
    const pre = [...p, ...n].filter((i) => i < s.start);
    const der = pre.filter((i) => !(i > 0 && c[i - 1] === '.'));
    const last = der.length ? Math.max(...der) : pre.length ? Math.min(...pre) - 1 : s.start - 1;
    if (narrow.some((i) => i <= s.end && (i > last || !/[;\n{}]/.test(c.slice(i, last))))) continue;
    // 名字查出来的：从第一个名字来源到这一处，提到共用进程名才拒（done < <(…) 里喂进来的看整条）
    const byName = n.length > 0 && SHARED_WORD_RE.test(n.includes(-1) ? raw : raw.slice(Math.min(...n), s.end));
    if (p.length) {
      // 端口来源没核对过；名字来源要是在它自己之后核对过（前一句按 CommandLine 筛过再停的），不算混着
      const nPre = n.filter((i) => i < s.start), lastN = nPre.length ? Math.max(...nPre) : Math.min(...n, s.start) - 1;
      (portHit ||= []).push(s);
      if (byName && !narrow.some((i) => i <= s.end && i > lastN)) portHit.mixed = true;
      continue;
    }
    if (byName) return deny('name');
  }
  // 同一处还有共用进程名来源的（kill $(lsof -ti:3000); kill $(pgrep node)）不做现场核查：端口干净不代表名字查出来的干净
  if (portHit) return { ...deny('port'), ports: portHit.mixed ? null : portsOf(c, raw, portHit, sites) };
  return null;
}

// ── 端口类的现场核查（2026-11-08 起）──────────────────────────────────────────
// 生产转录里端口类拒了 130 条，几乎全是会话停自己起的 vite / 测试服；真误杀只有 A5-57 那一次（双绑定）。
// 所以端口类先把命令里的字面端口抽出来，钩子里现场看一眼这些端口上是谁在监听再定。

// 循环变量 / 赋值里的字面端口：foreach ($port in 8791, 8793)、for p in 8831 8832; do、$port=28431、PORT=8791。
// 按位置认：用的地方往前最近的那次赋值 / 循环头说了算；那次不是字面（$port = ([uri]$x).Port、$pids += …）就当认不清。
// 返回 (名字, 位置) → 端口数组或 null。
function literalVars(raw) {
  const defs = [];
  const nums = (s) => s.split(/[\s,]+/).filter(Boolean).map(Number);
  const LIST = String.raw`\d{1,5}(?:\s*,\s*\d{1,5})*`;
  const PS_LIT = new RegExp(String.raw`^\\?\$\w+\s*=\s*(${LIST})\s*(?=[;\n}]|$)`);
  for (const m of raw.matchAll(/\\?\$(\w+)\s*([-+*/]?)=(?!=)/g)) {
    const l = !m[2] && PS_LIT.exec(raw.slice(m.index, m.index + 80));
    defs.push({ k: m[1].toLowerCase(), at: m.index, vals: l ? nums(l[1]) : null });
  }
  for (const m of raw.matchAll(/(?:^|[\s;&(])(?:export\s+|local\s+)?([A-Za-z_]\w*)=(\d{1,5}(?=[\s;&)]|$))?/g)) defs.push({ k: m[1].toLowerCase(), at: m.index, vals: m[2] ? [Number(m[2])] : null });
  const FE = new RegExp(String.raw`^foreach\s*\(\s*\\?\$\w+\s+in\s+(?:@\(\s*(${LIST})\s*\)|(${LIST}))\s*\)`, 'i');
  for (const m of raw.matchAll(/\bforeach\s*\(\s*\\?\$(\w+)\s+in\b/gi)) {
    const l = FE.exec(raw.slice(m.index));
    defs.push({ k: m[1].toLowerCase(), at: m.index, vals: l ? nums(l[1] || l[2]) : null });
  }
  for (const m of raw.matchAll(/\bfor\s+(\w+)\s+in\b/g)) {
    const l = /^for\s+\w+\s+in\s+(\d{1,5}(?:[ \t]+\d{1,5})*)\s*(?:;|\n)\s*do\b/.exec(raw.slice(m.index));
    defs.push({ k: m[1].toLowerCase(), at: m.index, vals: l ? nums(l[1]) : null });
  }
  defs.sort((x, y) => x.at - y.at);
  return (k, at) => {
    let d = null;
    for (const x of defs) if (x.k === k.toLowerCase() && x.at < at) d = x;
    return d && d.vals;
  };
}

// 来源这一段：到这一句结尾（管道算在内，括号配平）
function srcEnd(c, i) {
  let d = 0;
  for (; i < c.length; i++) {
    const ch = c[i];
    if (ch === '(' || ch === '{') d++;
    else if (ch === ')' || ch === '}') { if (--d < 0) return i; }
    else if (!d && (ch === ';' || ch === '\n' || ch === '&')) return i;
  }
  return i;
}

const VAR_REF = String.raw`\\?\$\{?(\w+)\}?`;
const PORT_VAL = String.raw`@?\(?\s*(?:(\d{1,5}(?:\s*,\s*\d{1,5})*)|${VAR_REF})`;

/** 一段端口来源里写到的端口：数组；有认不清的（变量算不出、正则通配）返回 null */
function segPorts(seg, vars, base) {
  const out = [];
  let bad = false;
  const take = (list, v, at) => {
    const r = !list && v ? vars(v, base + at) : null;
    if (list) out.push(...list.split(/\s*,\s*/).map(Number));
    else if (r) out.push(...r);
    else bad = true;
  };
  for (const m of seg.matchAll(new RegExp(String.raw`-LocalPort(?::|\s+)\s*${PORT_VAL}`, 'gi'))) take(m[1], m[2], m.index);
  for (const m of seg.matchAll(new RegExp(String.raw`\bLocalPort\s*-(?:eq|ieq|in|contains)\s*${PORT_VAL}`, 'gi'))) take(m[1], m[2], m.index);
  if (/-LocalPort\b(?![:\s]*[@(\d\\$])|\bLocalPort\s*-(?:eq|in|match|like|gt|lt|ge|le)\b(?!\s*[@(\d\\$])/i.test(seg)) bad = true;
  if (/(?:^|[\s|(;"'`$])(?:netstat|lsof|ss)(?=\s|$)/i.test(seg)) {
    // :8791、127.0.0.1:$p、[:.]$p、:(8797|8831)、lsof -ti:3000、findstr 8791；::1 这种 IPv6 里的冒号不算
    for (const m of seg.matchAll(new RegExp(String.raw`(?:(?<!:):|\[[:.]+\])(?:(\d{1,5})(?![\d[*+?{])|${VAR_REF}|\((\d{1,5}(?:\|\d{1,5})+)\)(?![*+?{]))`, 'g'))) {
      if (m[1]) out.push(Number(m[1]));
      else if (m[3]) out.push(...m[3].split('|').map(Number));
      else take(null, m[2], m.index);
    }
    for (const m of seg.matchAll(/\b(?:findstr|grep|Select-String|sls)\b((?:\s+(?:-\w+|\/\w+))*)\s+["']?(\d{2,5})(?=["'\s|;)]|$)/gi)) out.push(Number(m[2]));
    if (/(?<!:):\d{0,5}[[*+?{]|\[[:.]+\][[*+?{\d]/.test(seg)) bad = true;
  }
  const ports = out.filter((p) => p > 0 && p < 65536);
  return bad || !ports.length ? null : [...new Set(ports)];
}

/**
 * 按端口拒的那几处停进程，它们的端口来源里写的字面端口（去重）；抽不全（变量、通配、来源里没写端口）返回 null，维持原判。
 * 只给结果、不接管道也不赋值的顶层查询（netstat -ano | findstr :8787; …）不算来源：停进程拿不到它的输出。
 */
function portsOf(c, raw, hits, sites) {
  const vars = literalVars(raw);
  const srcs = [];
  for (const m of c.matchAll(PORT_SRC_RE)) {
    if (/OwningProcess/i.test(m[0])) continue;   // 读前面查好的连接对象，端口在查询那里
    const i = m.index + (/^[\s;&|(`$'"]/.test(m[0]) ? 1 : 0);
    const line = c.slice(c.lastIndexOf('\n', i - 1) + 1, i);
    const feedsLoop = /\bdone\s*<{1,3}[^;\n]*$/.test(line);
    const end = srcEnd(c, i);
    if (!feedsLoop && !hits.some((s) => i < s.end)) continue;
    if (!feedsLoop) {
      let d = 0;
      for (let k = 0; k < i; k++) { const ch = c[k]; if (ch === '(' || ch === '{') d++; else if (ch === ')' || ch === '}') d = Math.max(0, d - 1); }
      const head = c.slice(Math.max(c.lastIndexOf(';', i - 1), c.lastIndexOf('\n', i - 1), c.lastIndexOf('&', i - 1)) + 1, i);
      const seg = raw.slice(i, end);
      const display = d === 0 && !head.trim() && !sites.some((s) => s.start >= i && s.start < end)
        && !/(?:^|[^\d&2])>{1,2}\s*(?!\s*(?:nul\b|\$null\b|\/dev\/null\b|&))\S/i.test(seg);
      if (display) continue;
    }
    srcs.push([raw.slice(i, end), i]);
  }
  if (!srcs.length) return null;
  const all = [];
  for (const [seg, at] of srcs) { const p = segPorts(seg, vars, at); if (!p) return null; all.push(...p); }
  return [...new Set(all)];
}

// ── 现场查询（可注入：测试用桩）──────────────────────────────────────────────
// listeners(ports) → Map<端口, [{ pid, addr }]>（查不了就 throw）；procs(pids) → Map<pid, { name, cmd, created(ms), ppid }>；
// ancestors() → bridge 的父 / 祖先 PID 数组。全都不起窗口（windowsHide），超时由调用方掐。


function run(file, args, ms, signal) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: ms, maxBuffer: 8 << 20, encoding: 'utf8', signal }, (err, out) => {
      if (err) { err.stdout = out; reject(err); } else resolve(String(out));
    });
  });
}
const psRun = (script, ms, signal) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
  Buffer.from('$ErrorActionPreference="SilentlyContinue";[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script, 'utf16le').toString('base64')], ms, signal);

/** netstat -ano（0.1 秒级，PowerShell 的 Get-NetTCPConnection 要 1.5 秒以上）；监听 = 外部地址是 0.0.0.0:0 / [::]:0，不认本地化的状态词 */
export function parseNetstat(out, ports) {
  const want = new Set(ports), map = new Map(ports.map((p) => [p, []]));
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]|\*):(?:0|\*)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (!m || !want.has(Number(m[2]))) continue;
    map.get(Number(m[2])).push({ pid: Number(m[3]), addr: m[1] });
  }
  return map;
}

/** lsof -nP -iTCP -sTCP:LISTEN -Fpn：p<PID> 一行、n<地址:端口> 若干行 */
export function parseLsof(out, ports) {
  const want = new Set(ports), map = new Map(ports.map((p) => [p, []]));
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') {
      const m = /^(.*):(\d+)$/.exec(line.slice(1));
      if (m && want.has(Number(m[2])) && pid) map.get(Number(m[2])).push({ pid, addr: m[1] });
    }
  }
  return map;
}

const winProbe = {
  async listeners(ports, ms, signal) { return parseNetstat(await run('netstat', ['-ano'], ms, signal), ports); },
  async procs(pids, ms, signal) {
    const f = pids.map((p) => `ProcessId=${Number(p)}`).join(' or ');
    const out = await psRun(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${f}' | % { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; cmd=[string]$_.CommandLine; created=$(if ($_.CreationDate) { [long](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds) } else { 0 }) } })`, ms, signal);
    const arr = JSON.parse(out.trim() || '[]');
    return new Map((Array.isArray(arr) ? arr : [arr]).map((p) => [p.pid, p]));
  },
  async ancestors(ms) {
    // 父进程退出后 PID 会被复用：父进程得比子进程先创建才往上走
    const out = await psRun(`$id=${process.pid}; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id"; $o=@(); for($i=0;$i -lt 16 -and $p;$i++){ $q=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; if(-not $q -or $q.ProcessId -eq 0 -or $q.CreationDate -gt $p.CreationDate -or $o -contains [int]$q.ProcessId){break}; $o+=[int]$q.ProcessId; $p=$q }; $o -join ','`, ms);
    return out.trim().split(',').filter(Boolean).map(Number);
  },
};

function etimeMs(s) {   // ps 的 etime：[[dd-]hh:]mm:ss
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  return m ? (((+(m[1] || 0) * 24 + +(m[2] || 0)) * 60 + +m[3]) * 60 + +m[4]) * 1000 : NaN;
}
const posixProbe = {
  async listeners(ports, ms, signal) {
    try { return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], ms, signal), ports); }
    catch (e) { if (e && e.code === 1 && !e.stdout) return new Map(ports.map((p) => [p, []])); }   // lsof 什么都没找到时退出码 1
    // 退回 ss：没权限看别人的进程时 users:(…) 是空的，记成 pid null（当认不清）
    const out = await run('ss', ['-Htlnp'], ms, signal), want = new Set(ports), map = new Map(ports.map((p) => [p, []]));
    for (const line of out.split('\n')) {
      const m = /^\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s*(.*)$/.exec(line.trim());
      if (!m || !want.has(Number(m[2]))) continue;
      const pids = [...m[3].matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
      for (const pid of pids.length ? pids : [null]) map.get(Number(m[2])).push({ pid, addr: m[1] });
    }
    return map;
  },
  async procs(pids, ms, signal) {
    const out = await run('ps', ['-o', 'pid=,ppid=,etime=,args=', '-p', pids.join(',')], ms, signal), map = new Map(), now = Date.now();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (m) map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), created: now - etimeMs(m[3]), cmd: m[4], name: (m[4].split(/\s+/)[0] || '').split('/').pop() });
    }
    return map;
  },
  async ancestors(ms) {
    const o = [];
    for (let id = process.ppid, i = 0; id > 1 && i < 16 && !o.includes(id); i++) {
      o.push(id);
      id = Number((await run('ps', ['-o', 'ppid=', '-p', String(id)], ms)).trim());
    }
    return o;
  },
};
export const defaultProbe = WIN ? winProbe : posixProbe;

// bridge 的父 / 祖先一辈子不变：查成功一次就记住；查不到先只认 process.ppid，下次再查
let ancestorCache = null;
function bridgeAncestors(probe, ms) {
  if (probe !== defaultProbe) return probe.ancestors ? Promise.resolve(probe.ancestors(ms)).catch(() => []) : Promise.resolve([]);
  if (!ancestorCache) ancestorCache = probe.ancestors(ms).catch(() => { ancestorCache = null; return [process.ppid]; });
  return ancestorCache;
}

function deadline(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

/** 会话从什么时候开始：转录文件里第一个 timestamp（resume 的会话从最早那条算）。读不到返回 null，这条规则就不看 */
const startCache = new Map();
export function transcriptStart(path) {
  if (!path || typeof path !== 'string') return null;
  if (startCache.has(path)) return startCache.get(path);
  let t = null;
  try {
    const fd = fs.openSync(path, 'r');
    try {
      const buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      const ms = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(ms)) t = ms;
    } finally { fs.closeSync(fd); }
  } catch {}
  if (t !== null) { if (startCache.size > 500) startCache.clear(); startCache.set(path, t); }
  return t;
}

const brief = (p) => {
  if (!p) return '';
  const cmd = String(p.cmd || '').replace(/\s+/g, ' ').trim();
  return ` ${p.name || ''}${cmd ? `「${cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd}」` : ''}`;
};
const STOP_HOW = WIN ? 'taskkill /PID <PID> /T /F' : 'kill <PID>';

/**
 * 端口类拒绝的现场核查：命令里的字面端口上，每个都只有一个监听进程、不是 bridge 自己或它的父 / 祖先、
 * 也不是本会话开始前就在跑的 → 放行（null）；否则给出点名 PID 的拒绝。别的类、抽不出端口、查询失败超时 → 原判。
 * @param o  killGuardVerdict 的参数，另加 { probe, timeoutMs(默认 2000), procTimeoutMs(默认 3000), sessionStart(ms), signal }
 */
export async function killGuardCheck(command, o = {}) {
  const v = killGuardVerdict(command, o);
  if (!v || v.kind !== 'port' || !v.ports || !v.ports.length) return v;
  const probe = o.probe || defaultProbe, ms = o.timeoutMs ?? 2000, pms = o.procTimeoutMs ?? 3000;
  const anc = bridgeAncestors(probe, pms);
  let map;
  try {
    map = await deadline(Promise.resolve(probe.listeners(v.ports, ms, o.signal)), ms);
    if (!(map instanceof Map)) throw new Error('bad probe');
  } catch { return v; }
  const per = v.ports.map((p) => [p, [...new Set((map.get(p) || []).map((l) => l.pid))]]);
  if (per.some(([, ids]) => ids.some((id) => !Number.isInteger(id) || id <= 0))) return v;   // 有监听但看不到 PID（没权限）
  const pids = [...new Set(per.flatMap(([, ids]) => ids))];
  if (!pids.length) return null;   // 这些端口上现在没人监听：停不到别人
  const multi = per.filter(([, ids]) => ids.length > 1);
  const self = new Set([...(o.protectedPids || []), process.pid].filter((p) => Number.isInteger(p) && p > 0));
  const ancestors = new Set(await deadline(anc, pms).catch(() => [process.ppid]));
  if (process.ppid) ancestors.add(process.ppid);
  const own = per.find(([, ids]) => ids.some((id) => self.has(id) || ancestors.has(id)));
  let info = new Map();
  if (multi.length || own || o.sessionStart) {
    try { info = await deadline(Promise.resolve(probe.procs(pids, pms, o.signal)), pms); if (!(info instanceof Map)) info = new Map(); } catch { info = new Map(); }
  }
  const kind = 'port';
  if (own) {
    const id = own[1].find((x) => self.has(x) || ancestors.has(x));
    return { kind, ports: v.ports, reason: `没跑：端口 ${own[0]} 上监听的 PID ${id}${brief(info.get(id))} 是 bridge 服务${self.has(id) ? '本身' : '的父 / 祖先进程'}（你就跑在它里面），停了所有会话一起断。要重启按维护者流程排延后重启。` };
  }
  if (multi.length) {
    const list = multi.map(([p, ids]) => `端口 ${p}：` + ids.slice(0, 4).map((id) => `PID ${id}${brief(info.get(id))}`).join('；') + (ids.length > 4 ? ` 等 ${ids.length} 个` : '')).join('。');
    return { kind, ports: v.ports, pids, reason: `没跑：同一端口上有不止一个进程在监听${WIN ? '（Windows 上 0.0.0.0 和 127.0.0.1 能各占一个）' : ''}，按端口停会连带别人的。${list}。确认哪个是本会话起的，再按字面 PID 停（${STOP_HOW}）。` };
  }
  if (o.sessionStart) {
    const old = pids.find((id) => { const c = info.get(id) && info.get(id).created; return Number.isFinite(c) && c > 0 && c < o.sessionStart; });
    if (old) {
      const port = per.find(([, ids]) => ids.includes(old))[0];
      return { kind, ports: v.ports, pids: [old], reason: `没跑：端口 ${port} 上的 PID ${old}${brief(info.get(old))} 在本会话开始之前就在跑，不是本会话起的。确认就是要停它，再按字面 PID 停（${STOP_HOW}）；不是你的别动，端口被占就换端口。` };
    }
  }
  return null;
}

/**
 * PreToolUse（matcher 'Bash|PowerShell'）钩子：子 agent 的调用一样管（不看 agent_id）。只回 deny 或 { continue: true }。
 * @param o  { protectedPids?: 默认 bridge 服务自己的 process.pid；probe?: 现场查询（测试注入）；timeoutMs?；
 *             checkStart?: 默认 false（停别的会话 / 用户自己起的服务也会被拒，误拦多于收益）；true 时监听进程早于本会话（转录里第一条）就拒 }
 */
export function makeKillGuardHook(o = {}) {
  const protectedPids = o.protectedPids || [process.pid];
  if (!o.probe) bridgeAncestors(defaultProbe, 8000);   // 祖先链一个进程只查一次（Windows 约 2 秒），先在后台查好
  return async (input, _id, opts) => {
    const name = input && input.tool_name;
    if (name !== 'Bash' && name !== 'PowerShell') return { continue: true };
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    if (typeof ti.command !== 'string') return { continue: true };
    let v = null;
    const base = { shell: name === 'PowerShell' ? 'powershell' : 'bash', protectedPids };
    try { v = killGuardVerdict(ti.command, base); } catch {}
    if (v && v.kind === 'port' && v.ports) {
      try {
        v = await killGuardCheck(ti.command, { ...base, probe: o.probe, timeoutMs: o.timeoutMs, procTimeoutMs: o.procTimeoutMs,
          sessionStart: o.checkStart !== true ? null : transcriptStart(input.transcript_path), signal: opts && opts.signal });
      } catch {}   // 核查本身出错：维持原判
    }
    if (!v) return { continue: true };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } };
  };
}
