// 厂商的显示信息、自定义服务，以及宿主模型中心的挂钩。
import { t } from "../i18n.ts";
import { VENDOR_ORDER, VENDORS } from "../theme.ts";
import { brandLogoOf } from "../brand-logos.svelte.ts";
import { app } from "./core.svelte.ts";

// 厂商的名字与副标题：内置八家查 theme.ts 的 VENDORS；自定义服务（custom-<hex>）查服务端目录——名字是用户填的备注，
// 副标题是接口主机名。删掉了的自定义服务（历史会话还指着它）给个中性的占位。
export interface VendorView {
  id: string;
  name: string;
  company: string;
  custom: boolean;
  managed?: boolean; // 成员实例：管理员共享过来的（只能用：没有铅笔、设置里不填 Key）
  shared?: boolean; // 管理员实例：已共享给成员
  logo?: string; // 品牌标的键（brand-logos）：模型中心给的，或按接口主机名认出来的；没有就画首字
  hub?: string; // bridge 的模型中心提供的：它那边的服务 id（卡片上的铅笔据此跳回模型中心改）
}
export const isCustomVendor = (id: string | null | undefined) => typeof id === "string" && id.startsWith("custom-");
export function vendorInfo(id: string | null | undefined): VendorView {
  const key = id ?? "anthropic";
  if (isCustomVendor(key)) {
    const spec = (app.info?.catalog as any[] | undefined)?.find((p) => p.id === key);
    const managed = spec?.custom?.managed === true;
    // bridge 的模型中心提供的（经插件供模型那条路进来，pluginId = model-hub）：副标题直接写「模型中心」
    const hub = spec?.custom?.pluginId === "model-hub" ? String(spec.custom.ref ?? "") : "";
    const logo = spec?.custom?.logo || brandLogoOf(spec?.custom?.host);
    return {
      id: key,
      name: spec?.name ?? t("自定义服务"),
      // bridge 插件提供的（custom.plugin = 插件名）也是只能用不能改，副标题写插件名
      company: hub ? t("模型中心") : spec?.custom?.plugin ? `${t("插件")} · ${spec.custom.plugin}` : managed ? t("管理员共享") : (spec?.custom?.host ?? t("已删除")),
      custom: true,
      ...(managed ? { managed: true } : spec?.custom?.shared ? { shared: true } : {}),
      ...(logo ? { logo } : {}),
      ...(hub ? { hub } : {}),
    };
  }
  const v = VENDORS[key] ?? VENDORS.anthropic;
  // 自带适配的厂商由宿主的模型中心接管时：是它的哪个服务给的 Key（卡片上的铅笔跳回那个服务）
  const spec = (app.info?.catalog as any[] | undefined)?.find((p) => p.id === key);
  const hub = spec?.hub?.pluginId === "model-hub" ? String(spec.hub.ref ?? "") : "";
  return { id: v.id, name: v.name, company: v.company, custom: false, ...(hub ? { hub } : {}) };
}
// 宿主的模型中心接管了自带厂商（服务端 /api/info 的 hostBuiltins）：Key 只在模型中心里配，这边不再有填 Key 的地方，
// 「模型服务」面板也只摆模型中心给了 Key 的那几家。
export function hostBuiltins(): boolean {
  return (app.info as any)?.hostBuiltins === true;
}
// 用户加的自定义服务，按添加顺序
export function customVendors(): VendorView[] {
  const cat = (app.info?.catalog as any[] | undefined) ?? [];
  // 已经并进宿主模型中心的老服务（custom.hidden）不列：模型中心那边有它的新卡，老会话照样认得它的名字
  return cat.filter((p) => isCustomVendor(p.id) && !p.custom?.hidden).map((p) => vendorInfo(p.id));
}
// 能切过去的全部服务（「模型服务」面板与型号菜单的服务页共用）：自带适配的几家在前——宿主的模型中心接管以后只列它给了 Key 的
// 那几家（服务端目录里有的）和本机，否则八家全列——后面跟着模型中心 / 自定义服务
export function vendorChoices(): VendorView[] {
  const cat = (app.info?.catalog as any[] | undefined) ?? [];
  const builtins = VENDOR_ORDER.filter((id) => !hostBuiltins() || cat.some((p) => p.id === id)).map((id) => vendorInfo(id));
  return [...builtins, ...customVendors()];
}
// 宿主的模型中心（嵌在 bridge 里、当前身份是服务器管理员时才有）：模型服务只在那里配——「模型服务」面板的「＋」卡、
// 卡片上的铅笔都唤起它，这张面板自己不再有表单。返回 false = 宿主没接住（独立运行、成员、老 bridge），照旧用自己的表单。
//   "add"                 添加服务
//   { service }           打开模型中心里的这个服务（卡片是模型中心提供的）
//   { legacy, name, proto } dimensio 自己的老服务：交给模型中心（确认后照抄过去、删掉这边的）
//   不传                   打开模型中心首页
export type ModelHubTarget = "add" | { service: string } | { legacy: string; name: string; proto?: string };
// from：发起它的那块面板此刻在屏幕上的矩形与圆角（型号菜单里的「添加服务」），宿主让窗口从这里原地长出来；不给 = 宿主默认的入场
export interface ModelHubOpenOpts {
  from?: { x: number; y: number; w: number; h: number; r: number };
}
export interface ModelHubHost {
  available: () => boolean; // 现在能不能唤起（只探不开）
  open: (target?: ModelHubTarget, opts?: ModelHubOpenOpts) => boolean;
}
let hostModelHub: ModelHubHost | null = null;
export function setModelHubHost(host: ModelHubHost | null): void {
  hostModelHub = host;
}
export function hasHostModelHub(): boolean {
  try {
    return hostModelHub ? hostModelHub.available() === true : false;
  } catch {
    return false;
  }
}
export function openHostModelHub(target?: ModelHubTarget, opts?: ModelHubOpenOpts): boolean {
  try {
    return hostModelHub && hostModelHub.available() ? hostModelHub.open(target, opts) === true : false;
  } catch {
    return false;
  }
}

