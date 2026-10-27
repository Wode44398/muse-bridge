// 设置逻辑板的跨组件导航句柄：命令面板等外部入口先写 sec 再开 ui.settingsOpen，
// SettingsDesktop 挂载时消费、开着时再写也会被接住（读完即清），实现「直达某个设置分区」。
export const settingsNav = $state({ sec: null });
