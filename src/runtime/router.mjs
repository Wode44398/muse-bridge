// Tiny mini-router: register routes by method+path, dispatch on each request.
// Built for one-server-one-process use; no params, no regex paths — claude-bridge
// only ever uses exact paths and reads query/body itself.
//
// Supports a method as a single string OR an array of strings (so /api/attach can
// accept both GET and POST — a deliberate Cloudflare-tunnel workaround). Returns
// 404 for unmatched paths and 500 for handler exceptions; both honour
// `res.writableEnded` so a handler that already streamed (SSE) isn't double-written.
//
// 插件化（2026-10-26）：on / use / prefix 都返回撤销函数——插件停用时把它挂的路由与中间件原样摘掉
// （见 plugins/host.mjs 的 ctx.router）。中间件可带 order（小的先跑，缺省 0，同序按登记先后）：插件晚于核心
// 才启用，但预览子域这类 Host 接管必须排在 CORS 之前。prefix 路由只在精确路径都没命中时才看，最长前缀优先。

export function createRouter() {
  const routes = []; // { methods: Set<string>, path: string, handler: fn }
  let prefixes = []; // { methods: Set<string> | null, prefix: string, handler: fn }
  // 中间件表每次改动都换一个新数组：dispatch 正在遍历旧表时有插件停用 / 启用，不会跳过或重复。
  let middleware = []; // { fn, order, seq }
  let seq = 0;

  return {
    use: (fn, { order = 0 } = {}) => {
      const m = { fn, order, seq: seq++ };
      middleware = [...middleware, m].sort((a, b) => a.order - b.order || a.seq - b.seq);
      return () => { middleware = middleware.filter((x) => x !== m); };
    },
    on: (method, path, handler) => {
      const methods = new Set(Array.isArray(method) ? method : [method]);
      const r = { methods, path, handler };
      routes.push(r);
      return () => { const i = routes.indexOf(r); if (i >= 0) routes.splice(i, 1); };
    },
    // 前缀路由：method 传 null / '*' 表示任意方法。
    prefix: (method, prefix, handler) => {
      const methods = method == null || method === '*' ? null : new Set(Array.isArray(method) ? method : [method]);
      const p = { methods, prefix, handler };
      prefixes = [...prefixes, p].sort((a, b) => b.prefix.length - a.prefix.length);
      return () => { prefixes = prefixes.filter((x) => x !== p); };
    },
    has: (method, path) => routes.some((x) => x.methods.has(method) && x.path === path),
    // 当前挂着的全部精确路由（插件管理与测试对拍用）
    list: () => routes.map((r) => ({ methods: [...r.methods], path: r.path })),
    dispatch: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      try {
        for (const m of middleware) {
          const cont = await m.fn(req, res, url);
          if (cont === false) return;
        }
        const r = routes.find((x) => x.methods.has(req.method) && x.path === url.pathname)
          || prefixes.find((x) => (!x.methods || x.methods.has(req.method)) && url.pathname.startsWith(x.prefix));
        if (!r) {
          if (!res.writableEnded) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
          return;
        }
        await r.handler(req, res, url);
      } catch (e) {
        console.error('route error:', e);
        if (!res.writableEnded) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('internal error'); }
      }
    },
  };
}
