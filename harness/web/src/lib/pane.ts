// 分屏（宽屏多会话）：每一格（ChatPane）给自己的子树一个「这一格」的上下文——格里的组件显示这一格的会话
// （pane.chat），不是 app.chat（有焦点的那一格）。不在任何格里（侧栏、工作区、各种 sheet）= 退回 app.chat。
//
// 动作照旧走 state 里的函数（它们作用于 app.chat）：点进哪一格、焦点落进哪一格，那一格先成为 app.chat（ChatPane 在
// 捕获阶段挪焦点），所以格里的按钮作用的正是这一格。只有「显示」要认 pane.chat。
import { getContext, setContext } from "svelte";
import { app, type Chat } from "./state.svelte.ts";

export interface Pane {
  readonly chat: Chat;
  // 有焦点（= app.chat）；没分屏时恒为 true
  readonly focused: boolean;
  // 分屏中（两格并排）
  readonly split: boolean;
  // 第几格（0 = 左）
  readonly index: number;
}

const KEY = Symbol("hx-pane");
const FALLBACK: Pane = {
  get chat() {
    return app.chat;
  },
  focused: true,
  split: false,
  index: 0,
};

export function providePane(pane: Pane): void {
  setContext(KEY, pane);
}

export function usePane(): Pane {
  return getContext<Pane | undefined>(KEY) ?? FALLBACK;
}
