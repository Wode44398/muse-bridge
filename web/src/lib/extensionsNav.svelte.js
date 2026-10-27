// 扩展面板的跨组件导航句柄（同 settingsNav 模式）：设置外壳先写 type 再显示「扩展」分区，
// components/ext/Customize 挂载时消费一次（读完即清），实现「直达某个类型」。
export const extensionsNav = $state({ type: null });
