// Markdown 渲染能力的「代次」信号。
//
// 为什么需要它：renderMarkdown 是同步函数、在模板里被 {@html} 直接调用，而 KaTeX 现在
// 是按需加载的（见 md.js）。首次遇到公式时 katex 还没到，那一次渲染只能吐出原样的 $...$；
// 等它加载完，必须让【所有已经渲染出去的 markdown】重跑一遍，否则公式就永久停在原文。
//
// 做法：katex 就绪后 epoch++，而 renderMarkdown / renderObsMd 内部读一次 epoch。
// Svelte 5 的响应式是运行时信号，读取发生在哪个模块无所谓——只要这次读取处于模板
// 表达式的求值过程中，依赖就建立了。于是【每一个在模板里调用 renderMarkdown 的地方
// 都自动重渲】，各消费方（Thread / ExtensionsPage …）一行都不用改。
//
// 单独开这个 .svelte.js 文件是因为 $state 只能在 .svelte.js 里【声明】；md.js 是普通 .js，
// 但可以照常【读取】这个 state。
export const mdState = $state({ epoch: 0 });
