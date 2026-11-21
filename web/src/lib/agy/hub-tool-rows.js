// Antigravity 设置 › Bridge 工具：服务端工具中枢（modules/agy/server/mcp/hub.mjs）各组的开关行。
// 桌面设置分区与手机设置子页共用；plugin = 对应的扩展中心功能插件（没开时该组不会挂载，开关置灰）。
import { t } from '../i18n.js';

export const AGY_HUB_TOOL_ROWS = [
  { key: 'browser', plugin: 'browser', title: t('侧边浏览器'), desc: t('驱动当前会话的浏览器，与右侧工作区「浏览器」卡片是同一个实例，可打开页面、点按输入、截图核对') },
  { key: 'terminal', plugin: 'terminal', title: t('共享终端'), desc: t('读写右侧工作区「终端」卡片里那个 shell，你和 Antigravity 看到的是同一屏') },
  { key: 'workspace', plugin: 'workspace-tools', title: t('工作区协同'), desc: t('看你正在预览的文件和未保存的草稿，把做好的文件直接弹到你眼前，截取你此刻的画面') },
  { key: 'bridgeOps', plugin: 'agent-api', title: t('bridge 手册与操作'), desc: t('查 bridge 的项目手册，替你管定时任务、会话、扩展与设置，诊断并上报 bug') },
  { key: 'device', plugin: '', title: t('操作我的电脑'), desc: t('看屏幕、点按输入、读写文件、跑命令，作用在你登记过的电脑上（需要至少一台在线设备）') },
  { key: 'visualize', plugin: 'visualize', title: t('内嵌图表'), desc: t('把图表、流程图和交互小部件直接画进对话') },
  { key: 'sessions', plugin: 'session-tools', title: t('会话协作'), desc: t('另开 Claude 子会话并行干活，子会话做完把汇报转回来、让 Antigravity 接着做') },
  { key: 'phoneControl', plugin: 'phone-control', title: t('操控我的手机'), desc: t('看屏幕、点按输入、开 app，作用在开着「手机操控」的安卓手机上；发短信、打电话先问你') },
  { key: 'pr', plugin: 'pr', title: t('拉取请求'), desc: t('把会话和它建的 PR 绑在一起，看 CI 与评审；开自动修复、自动合并前先问你') },
  { key: 'projectMemory', plugin: '', title: t('项目记忆'), desc: t('读写这个项目（或这个文件夹）里各个会话共用的记忆') },
  { key: 'pluginTools', plugin: '', title: t('插件工具'), desc: t('用你装的插件声明给 Antigravity 的工具') },
  { key: 'remoteConnectors', plugin: '', title: t('远程连接器'), desc: t('由 bridge 代连扩展中心里勾了 Antigravity 的 http / sse 连接器；每次调用都先问你') },
];
