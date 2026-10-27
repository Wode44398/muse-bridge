// 回归：PrChip / PrCard 的 `$effect(() => watchPr(sid))` 曾死循环（每秒上百次 GET /api/claude/pr）。
// 做法：用 svelte 编译器把真的 pr.svelte.js 编成客户端模块（依赖换成桩），在 $effect.root 里按组件的写法挂上，
// 数一段时间内的请求次数——挂载时只该拉一次，之后按 schedule 的间隔（≥15 秒）才会再拉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));

const STUBS = {
  'api.js': `export const calls = []; export const api = { async get(u) { calls.push(u); await new Promise((r) => setTimeout(r, 5)); return { view: { available: true, prs: [], git: { github: true }, pollMs: 30000 } }; }, async post() { return {}; } };`,
  'bus.js': `export const busOn = () => () => {};`,
  'csnap.js': `export const IS_CSNAP = false;`,
  'nativeDesktop.js': `export const isNativeDesktop = () => false; export const desktopOpenExternal = () => {};`,
  'store.js': `export const storeGet = () => null; export const storeSet = () => {};`,
  'toast.svelte.js': `export const showToast = () => {};`,
  'i18n.js': `export const t = (s) => s; export const tc = (_c, s) => s;`,
  'prText.js': `export const mainPr = () => null, ciStatus = () => '', conflicting = () => false, prTone = () => '', createBlocker = () => '', baseOf = () => '', createPrPrompt = () => '', compareUrl = () => '', syncConflictPrompt = () => '', prEnvelope = () => '';`,
};

test('watchPr 挂在 $effect 里：挂载只拉一次，不因拉取过程读写的状态重跑（死循环回归）', async () => {
  const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-test-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const [f, src] of Object.entries(STUBS)) writeFileSync(join(dir, f), src);
    const prSrc = readFileSync(join(here, 'pr.svelte.js'), 'utf8');
    writeFileSync(join(dir, 'pr.svelte.js'), fixImports(compileModule(prSrc, { filename: 'pr.svelte.js', generate: 'client' }).js.code));
    // 按组件里最朴素的写法挂（不在调用方 untrack）：模块自己要扛得住
    const harness = `
      import { watchPr, prViewOf } from './pr.svelte.js';
      import { flushSync } from 'svelte';
      export function mount(sid) {
        const st = $state({ sid });
        const stop = $effect.root(() => { $effect(() => watchPr(st.sid)); $effect(() => { prViewOf(st.sid); }); });
        flushSync();
        return { stop, set(v) { st.sid = v; flushSync(); } };
      }`;
    writeFileSync(join(dir, 'harness.svelte.js'), fixImports(compileModule(harness, { filename: 'harness.svelte.js', generate: 'client' }).js.code));
    const { calls } = await import(pathToFileURL(join(dir, 'api.js')).href);
    const { mount } = await import(pathToFileURL(join(dir, 'harness.svelte.js')).href);

    const m = mount('sess-aaaaaaaa');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.length, 1, `挂载后 400ms 内应只拉一次，实际 ${calls.length} 次`);
    // 换会话：旧的停、新的拉一次
    m.set('sess-bbbbbbbb');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls.length, 2, `换会话后应只多拉一次，实际共 ${calls.length} 次`);
    assert.match(calls[1], /sess-bbbbbbbb/);
    m.stop();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
