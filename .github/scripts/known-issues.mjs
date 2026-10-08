#!/usr/bin/env node
// 把 deploy/muse/known-issues.json 算成发布频道里的 known_issues（stdout 打印一个 JSON 数组）。
// 装好的 Muse 只知道自己的提交短哈希（deploy/muse/VERSION 第一段），不知道标签，所以这里把
// 「since ~ fixed_in 之间的版本」换算成那些版本的提交短哈希（commits），看门狗按前缀比对。
//   用法：node .github/scripts/known-issues.mjs        （在仓库里跑，要有全部标签：git fetch --tags）
// release.yml 发版时、known-issues.yml 改清单时都调它。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const src = JSON.parse(readFileSync(new URL('../../deploy/muse/known-issues.json', import.meta.url), 'utf8'));

// 发布过的版本：v* 标签，去掉 -test 试装版（不进更新频道），按创建时间排
const tags = git('tag', '--list', 'v*', '--sort=creatordate').split('\n').filter((t) => t && !/-test/.test(t));
const short = (t) => git('rev-parse', '--short=7', `${t}^{commit}`);

const out = [];
const seen = new Set();
for (const it of src.issues || []) {
  if (!it.id || seen.has(it.id)) throw new Error(`known-issues.json：id 缺失或重复：${it.id}`);
  seen.add(it.id);
  const from = it.since ? tags.indexOf(it.since) : 0;
  if (from < 0) throw new Error(`${it.id}：since 写的标签 ${it.since} 不存在`);
  // fixed_in 的标签还没发（修好了、还没发版）：当作没修好，影响到最新版为止
  const fixedAt = it.fixed_in ? tags.indexOf(it.fixed_in) : -1;
  const affected = tags.slice(from, fixedAt >= 0 ? fixedAt : tags.length);
  out.push({
    id: it.id,
    title: it.title, title_en: it.title_en || '',
    symptom: it.symptom || '', workaround: it.workaround || '', workaround_en: it.workaround_en || '',
    fixed_in: it.fixed_in || null, fixed: fixedAt >= 0,
    notify: it.notify === true,
    issue: Number.isInteger(it.issue) ? it.issue : null,
    commits: affected.map(short),
  });
}
process.stdout.write(JSON.stringify(out));
