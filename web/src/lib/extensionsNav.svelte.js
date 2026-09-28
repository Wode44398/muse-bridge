// 扩展中心的跨组件导航句柄（同 settingsNav 模式）：外部入口先写 type 再开
// ui.extensionsOpen，ExtensionsPage 挂载时消费一次（读完即清），实现「直达某个类目」。
export const extensionsNav = $state({ type: null });
