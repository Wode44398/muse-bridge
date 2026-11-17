// 桌面设置的上下文：外壳 SettingsDesktop.svelte 初始化时按原来的先后创建各控制器（本目录的 *.svelte.js），连同外壳自己的状态
// （当前分区 sec / 子页 clSub、导航、搜索闪烁 fl、明暗、桌面壳的几座桥）挂成一个对象 D 放进 context；各分区组件取出来只管画。
import { getContext, setContext } from 'svelte';

const KEY = Symbol('settings-desk');
export const provideDesk = (D) => setContext(KEY, D);
export const useDesk = () => getContext(KEY);

// 没登录时的头像：一个人形剪影（侧栏账户行与账户分区的头图共用）
export const PERSON = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="5.4" r="2.7" fill="currentColor"/><path d="M2.8 13.4c.7-2.6 2.8-4 5.2-4s4.5 1.4 5.2 4Z" fill="currentColor"/></svg>';
