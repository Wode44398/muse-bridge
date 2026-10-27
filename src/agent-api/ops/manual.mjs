// 查手册：目录、整章、按关键词检索小节。

import { defineOp, OpError } from '../registry.mjs';
import { manualToc, manualChapter, manualSearch } from '../manual.mjs';

defineOp({
  name: 'manual', title: '查 bridge 项目手册',
  desc: '不带参数 = 目录（各章 id、标题、摘要、小节名）；topic = 整章；q = 关键词检索，返回最相关的几个小节全文。用户问「这个 app 怎么 / 在哪 / 能不能……」先查这里，手册里没有的功能就当没有。',
  params: {
    topic: { type: 'string', max: 40, desc: '章 id（见目录），如 claude、workspace、settings' },
    q: { type: 'string', max: 200, desc: '关键词，空格分隔多个' },
    limit: { type: 'integer', min: 1, max: 10, default: 4, desc: '检索返回几个小节' },
  },
  handler: async (ctx, args, env) => {
    if (args.topic) {
      const c = manualChapter(args.topic, ctx, env.origin);
      if (!c) throw new OpError('not_found', '没有这一章：' + args.topic, { hint: '不带参数调一次 manual 看目录' });
      return c;
    }
    if (args.q) return { q: args.q, results: manualSearch(args.q, ctx, env.origin, { limit: args.limit }) };
    return { chapters: manualToc(ctx, env.origin) };
  },
});
