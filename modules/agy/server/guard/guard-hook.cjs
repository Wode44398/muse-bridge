// agy 的 PreToolUse 钩子（注册用户的 agy 进程专用，由 install.mjs 拷进它的配置目录）。
// agy 每次调用工具前把调用内容经标准输入交来；这里原样转给 bridge 判，把结论写到标准输出。
//
// 任何一步出错（bridge 没应答、超时、回的不是预期内容）都以非零退出——agy 对钩子失败的处理是「这次工具调用不执行」
// （实测），所以出错即拒绝，绝不放行。只依赖 node 自带模块：这个文件被拷到别处单独运行。
//
// 写给 agy 的内容（标准输出的结论、标准错误的报错）一律只用 ASCII：Windows 上 agy 按系统代码页读钩子的输出，
// 直接写 UTF-8 的中文会被读坏，这次工具调用连同之后整轮都报「invalid UTF-8」（实测）。
// 结论里的中文写成 JSON 的 \uXXXX 转义，agy 解析 JSON 后拿到的还是原文。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const fail = (msg) => { process.stderr.write('bridge guard: ' + msg + '\n'); process.exit(2); };
const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

let conf;
try { conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'guard.json'), 'utf8')); } catch (e) { fail('cannot read guard.json'); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; if (raw.length > 4 * 1024 * 1024) fail('payload too large'); });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { fail('payload is not valid JSON'); return; }
  let url;
  try { url = new URL(String(conf.api || '') + '/api/agy/internal/guard'); } catch (e) { fail('bad api url in guard.json'); return; }
  const body = Buffer.from(JSON.stringify({ payload }));
  const req = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    agent: false,
    timeout: 6000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      Authorization: 'Bearer ' + String(conf.token || ''),
      'X-Bridge-Agent': 'agy',
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('error', () => fail('error reading response'));
    res.on('end', () => {
      if (res.statusCode !== 200) { fail('bridge answered ' + res.statusCode); return; }
      let j;
      try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { fail('response is not valid JSON'); return; }
      if (!j || j.ok !== true) { fail('bridge gave no decision'); return; }
      // out 为空 = 不表态：什么都不输出，agy 照平常的流程走
      // 有结论时等它确实写出去了再退：管道上的写是异步的，写完之前退出会把「拒绝」丢掉，agy 就当成没表态
      if (j.out && typeof j.out === 'object') {
        const done = setTimeout(() => fail('could not write the decision'), 3000);
        process.stdout.write(asciiJson(j.out), (err) => { clearTimeout(done); if (err) fail('could not write the decision'); else process.exit(0); });
        return;
      }
      process.exit(0);
    });
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', () => fail('cannot reach bridge'));
  req.end(body);
});
process.stdin.on('error', () => fail('error reading payload'));
