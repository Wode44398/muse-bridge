import http from "node:http";
import type { AddressInfo } from "node:net";

// A per-service reverse proxy that sits in front of the app the agent is running
// and injects a tiny probe script into HTML responses. The probe reports the
// browser-side signals a non-multimodal model can't otherwise see — console
// output, uncaught errors, and failed fetches — back to /__probe as plain text.
//
// It's a port-level 1:1 proxy (not a sub-path prefix), so the app's absolute
// URLs (/api, /login.html, 302 redirects) all keep working without rewriting.

export interface BrowserLog {
  t: number;
  type: string;
  msg: string;
}

export interface PreviewProxy {
  port: number;
  close: () => void;
}

const PROBE_PATH = "/__probe";
const MAX_BODY = 64 * 1024;

// Installed as early as possible (before other scripts) so it captures their
// errors too. Uses sendBeacon so reports survive page unload; never routes its
// own reports through the wrapped fetch (avoids recursion).
const PROBE_JS = `(function(){
var EP=${JSON.stringify(PROBE_PATH)};
function send(t,m){try{var b=JSON.stringify({type:t,msg:m});if(navigator.sendBeacon){navigator.sendBeacon(EP,b);}else{fetch(EP,{method:"POST",body:b,keepalive:true});}}catch(e){}}
["log","info","warn","error","debug"].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){var s=[];for(var i=0;i<arguments.length;i++){var a=arguments[i];try{s.push(typeof a==="string"?a:JSON.stringify(a));}catch(e){s.push(String(a));}}send("console."+k,s.join(" "));return o.apply(null,arguments);};});
window.addEventListener("error",function(e){send("error",(e.message||"script error")+" @ "+(e.filename||"")+":"+(e.lineno||0));});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;send("unhandledrejection",String(r&&(r.stack||r.message)||r));});
var of=window.fetch;if(of){window.fetch=function(){var u=arguments[0];var url=typeof u==="string"?u:(u&&u.url)||"";return of.apply(this,arguments).then(function(r){if(!r.ok)send("fetch",r.status+" "+url);return r;},function(err){send("fetch-error",String(err)+" "+url);throw err;});};}
send("probe","installed on "+location.href);
})();`;

function injectProbe(html: string): string {
  const tag = `<script>${PROBE_JS}</script>`;
  if (html.includes("</head>")) return html.replace("</head>", tag + "</head>");
  const m = html.match(/<body[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + tag);
  return tag + html;
}

export function startProxy(
  targetPort: number,
  onLog: (log: BrowserLog) => void,
): Promise<PreviewProxy> {
  const server = http.createServer((req, res) => {
    // Probe reports never reach the app.
    if (req.method === "POST" && req.url === PROBE_PATH) {
      let body = "";
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) body += c.toString();
      });
      req.on("end", () => {
        try {
          const o = JSON.parse(body);
          onLog({ t: Date.now(), type: String(o.type || "log"), msg: String(o.msg ?? "").slice(0, 2000) });
        } catch {
          /* ignore malformed */
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }

    // Force identity encoding so we can read/inject HTML without gunzipping.
    const headers = { ...req.headers, "accept-encoding": "identity" };
    const proxyReq = http.request(
      { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers },
      (pRes) => {
        const ct = String(pRes.headers["content-type"] || "");
        if (ct.includes("text/html")) {
          const chunks: Buffer[] = [];
          pRes.on("data", (c: Buffer) => chunks.push(c));
          pRes.on("end", () => {
            const out = injectProbe(Buffer.concat(chunks).toString("utf8"));
            const h = { ...pRes.headers };
            delete h["content-length"];
            delete h["content-encoding"];
            res.writeHead(pRes.statusCode || 200, h);
            res.end(out);
          });
        } else {
          res.writeHead(pRes.statusCode || 200, pRes.headers);
          pRes.pipe(res);
        }
      },
    );
    proxyReq.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`preview proxy error: ${e.message}`);
    });
    req.pipe(proxyReq);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}
