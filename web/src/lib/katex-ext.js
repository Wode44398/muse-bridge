// KaTeX 懒加载分包的入口。存在的唯一理由：让 katex 的 JS 与 CSS 进同一个 chunk。
//
// 别把 CSS 写成 md.js 里另起一条的 import('katex/dist/katex.min.css')——那样 Vite 虽然
// 也会吐出 katex-*.css，却【不会】把它登记进 __vitePreload 的依赖表（实测：xterm /
// mdeditor 的 CSS 都在表里，唯独这样写出来的 katex CSS 不在）。结果是分包加载后样式
// 从没被注入，公式渲染出来是一团重叠错位的字符——比不渲染更难看，而且只有生产构建
// 才会犯（dev 下 CSS 走的是另一条注入路径，测不出来）。
//
// 把 CSS 作为【被动态 import 的模块内部的静态 import】，Rollup 就会把它算作这个 chunk
// 的 CSS 依赖，随 chunk 一起注入。
import markedKatex from 'marked-katex-extension';
import 'katex/dist/katex.min.css';

export default markedKatex;
