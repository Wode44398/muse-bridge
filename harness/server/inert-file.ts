import path from "node:path";
import type { Response } from "express";

// #65：dimensio 把 agent 写的文件经 /api/sessions/:id/artifact 和 /api/dock/file 直接
// 交给浏览器。经 bridge 反代时这些响应落在 bridge 的源上，而资源链接的 query 里带着令牌
// （bridge 的 ?token= 或独立开发的 ?dimensio_token=）：一份 agent 写的 .html 只要被顶层
// 打开（旧独立 UI 的新窗口、复制出去的链接），就能读到自己 URL 里的令牌、以登录身份调 API。
// 与 bridge 自己的文件接口同规矩（src/runtime/http-file.mjs 的 safe:true）：能执行脚本或
// 活动标记的类型一律按纯文本给，并用 CSP sandbox 禁掉执行。查看器本来就是取文本、放进
// 无 allow-same-origin 的沙箱 srcdoc 渲染，界面不受影响。
const TEXT_ACTIVE = new Set([
  "html", "htm", "xhtml", "xht", "shtml", "mht", "mhtml", "hta",
  "xml", "xsl", "xslt", "rdf",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "vue", "php",
]);
// SVG 在 dimensio 里按图片展示（<img> 里的 SVG 本来就不跑脚本），类型保留；只给顶层
// 打开加上 sandbox，让它成为不执行脚本的不透明源。
const IMAGE_ACTIVE = new Set(["svg", "svgz"]);

export function inertFileHeaders(res: Response, file: string): void {
  const ext = path.extname(file).slice(1).toLowerCase();
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (TEXT_ACTIVE.has(ext)) {
    // sendFile 不会覆盖已设的 Content-Type（send 模块先查 getHeader）。
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Security-Policy", "sandbox");
  } else if (IMAGE_ACTIVE.has(ext)) {
    res.setHeader("Content-Security-Policy", "sandbox; script-src 'none'");
  }
}
