// HtmlView srcdoc 回落路径的滚动条垫片：与服务端 SCROLLBAR_SHIM 逐字节一致，且 <script> 能正确闭合（防 srcdoc 白屏复发）。
// 跑法：node --test web/src/lib/htmlInline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCROLLBAR_SHIM } from './htmlInline.js';
import { SCROLLBAR_SHIM as SERVER_SHIM } from '../../../src/runtime/html-site.mjs';

test('前端滚动条垫片与服务端 SCROLLBAR_SHIM 逐字节一致', () => {
  assert.equal(SCROLLBAR_SHIM, SERVER_SHIM);
});

test('垫片里的 <style> / <script> 各闭合一次，没有多转义的 <\\/script>', () => {
  assert.equal((SCROLLBAR_SHIM.match(/<script>/g) || []).length, 1);
  assert.equal((SCROLLBAR_SHIM.match(/<\/script>/g) || []).length, 1);
  assert.equal((SCROLLBAR_SHIM.match(/<\/style>/g) || []).length, 1);
  assert.ok(!SCROLLBAR_SHIM.includes('<\\/script'), '字面量多转义了一层：标签关不上，正文会被吞进脚本');
  assert.ok(SCROLLBAR_SHIM.endsWith('</script>'));
});

test('拼进页面后正文留在脚本外面', () => {
  const page = '<!DOCTYPE html><html><head><title>x</title></head><body><p id="hello">正文</p></body></html>';
  const out = page.replace(/<head\b[^>]*>/i, (m) => m + SCROLLBAR_SHIM);
  // 粗略的 HTML 分词：从第一个 <script> 起，第一个 </script> 之后必须还能看到正文
  const open = out.indexOf('<script>');
  const close = out.indexOf('</script>', open);
  assert.ok(open > 0 && close > open);
  assert.ok(out.indexOf('<p id="hello">') > close, '正文落在了脚本里');
});
