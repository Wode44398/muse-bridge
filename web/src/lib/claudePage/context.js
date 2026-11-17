// Claude 页的页面上下文：外壳建一个对象经 context 交给子组件；外壳与各区段工厂把自己的状态以 getter / setter 挂上去。
import { getContext, setContext } from 'svelte';

const KEY = Symbol('claudePage');

// 把一个对象上的属性描述符（getter / setter / 值）原样挂到页面上下文上——不能用 Object.assign：它会把 getter 读成死值。
export function expose(target, src) {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(src));
  return target;
}
export function providePage(pc) { setContext(KEY, pc); return pc; }
export function usePage() { return getContext(KEY); }
