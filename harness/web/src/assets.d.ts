// 静态资源模块的类型（vite 把它们解析成 URL 字符串）。svelte-check 用的 tsconfig.check.json 不带 vite/client 类型，这里补上用到的几种。
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.woff2" {
  const src: string;
  export default src;
}
