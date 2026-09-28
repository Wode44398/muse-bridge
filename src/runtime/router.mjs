// Tiny mini-router: register routes by method+path, dispatch on each request.
// Built for one-server-one-process use; no params, no regex paths — claude-bridge
// only ever uses exact paths and reads query/body itself.
//
// Supports a method as a single string OR an array of strings (so /api/attach can
// accept both GET and POST — a deliberate Cloudflare-tunnel workaround). Returns
// 404 for unmatched paths and 500 for handler exceptions; both honour
// `res.writableEnded` so a handler that already streamed (SSE) isn't double-written.

export function createRouter() {
  const routes = []; // { methods: Set<string>, path: string, handler: fn }
  const middleware = []; // (req, res, url) => false | void

  return {
    use: (fn) => { middleware.push(fn); },
    on: (method, path, handler) => {
      const methods = new Set(Array.isArray(method) ? method : [method]);
      routes.push({ methods, path, handler });
    },
    dispatch: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      try {
        for (const m of middleware) {
          const cont = await m(req, res, url);
          if (cont === false) return;
        }
        const r = routes.find((x) => x.methods.has(req.method) && x.path === url.pathname);
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
