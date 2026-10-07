// 扩展中心的跨组件导航句柄（同 settingsNav 模式）：外部入口先写 type 再开
// ui.extensionsOpen，ExtensionsPage 挂载时消费一次（读完即清），实现「直达某个类目」。
// id = 直落某个扩展的详情；action: 'connector' = 直接打开「添加连接器」表单（「自定义」页的入口用）。
export const extensionsNav = $state({ type: null, id: null, action: null });

// 「自定义」页（Claude 分页里的 Customize）的直达句柄：设置里点「技能 / 连接器 / 插件」先写 tab 再开页。
export const customizeNav = $state({ tab: null });
