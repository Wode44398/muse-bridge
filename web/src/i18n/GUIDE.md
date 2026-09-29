# 界面多语言（简体中文 / English）约定

bridge 前端（`web/src`）与 dimensio（`harness/web/src`，经 `@hx` 编进 bridge）共用一套翻译层。
**中文原文就是键**（gettext 式）：源码里照旧写中文，外面包一层 `t()`；英文放在分区字典里。
默认简体中文；设置 → 通用 → 语言 切到 English 后整页重载。术语与文风见同目录 `GLOSSARY.md`。

## 1. 怎么写

```js
import { t, tc, tr } from '../lib/i18n.js';          // dimensio：from '../../lib/i18n.ts'

t('新建对话')                                         // 普通文案
t('已选 {n} 项', { n: sel.length })                   // 占位符 {名字}，中英两边同名
t('{name} 已上传', { name })                          // 占位符可以放任何位置，英文按英语语序排
tc('开关', '关闭')                                    // 同一句中文在不同语境要不同英文：字典键写 '开关::关闭'
tr(e.message)                                         // 运行时才知道的文案（服务端报错、能力表标签……）
```

- **Svelte 模板**：`<span>保存</span>` → `<span>{t('保存')}</span>`；静态属性 `title="关闭"` → `title={t('关闭')}`；
  `aria-label` / `placeholder` / `alt` 同样要包。
- **拼接的句子必须改成一整句带占位符**，不能分段翻译：
  `'已删除 ' + n + ' 个文件'` → `t('已删除 {n} 个文件', { n })`。英文语序与中文不同，分段翻不对。
- **单复数**：英文值写成对象，按参数 `n`（或 `count`）取：`{ one: '{n} file', other: '{n} files' }`。
- **键必须是字面量**：`t(cond ? '甲' : '乙')` 查不到，要写 `cond ? t('甲') : t('乙')`；`t(\`…${x}…\`)` 改占位符。
- **tr() 的匹配规则**：先整句精确匹配；再把字典里带 `{占位}` 且字面部分 ≥ 2 个汉字的键当模板去匹配（服务端报错
  `会话 abc 不存在` 能命中键 `会话 {id} 不存在`）。只用在「文案来自服务端 / 数据」的显示点，不要拿它代替 t()。
- **模块顶层常量里可以直接调 t()**：入口（`main.js` / `quick.js` / `solo.js` / dimensio 的 `main.ts`）先
  `await initI18n()` 再动态加载业务模块，所以任何业务模块求值时字典都已就绪。唯一例外是入口里静态导入的
  `lib/devDesktopMock.js`、`lib/staleGuard.js`：它们在字典之前求值，只能在函数里（运行时）调 t()。

## 2. 什么不翻（保持中文，行尾加注释 `// i18n-ignore` 让检查器放过）

- 跟服务端 / 数据做**比较或匹配**的中文：`if (msg === '未登录')`、`/已完成/.test(s)`、存进 localStorage 的值。
  翻了逻辑就断。显示给人看的那一处另外用 `tr()` 包。
- **发给 AI 的隐藏提示词**（系统提示、工具说明）——不是界面。**但**会预填进输入框、用户看得见的提示词要翻。
- 语言名本身（「简体中文」永远用中文写）、日志 `console.*`（检查器自动跳过）。
- 开发专用页（`?dkit` / `?dglass` 画廊等）：文件里写 `i18n-ignore-file`。

## 3. 字典文件

- bridge：`web/src/i18n/en/<分区>.js`，dimensio：`harness/web/src/i18n/en/<分区>.ts`，格式：
  ```js
  // 英文界面文案 · <分区说明>（键 = 中文原文，见 lib/i18n.js）
  export default {
    '新建对话': 'New chat',
    '已选 {n} 项': { one: '{n} item selected', other: '{n} items selected' },
    '开关::关闭': 'Off',
  };
  ```
- 目录下所有文件自动合并（`import.meta.glob`），不用登记。只在英文时才下载，中文用户零成本。
- **同一个中文键在所有文件里英文必须一致**。确需不同译法用语境键（`tc()`）。
- dimensio 的键要进 dimensio 的字典（它能独立运行，读不到 bridge 字典）。

## 4. 检查

```bash
node web/scripts/i18n-check.mjs <文件或目录…>        # 查这些文件：LEFTOVER / MISSING / SHADOW / DICT / DYNAMIC
node web/scripts/i18n-check.mjs --summary            # 全量：每个文件还剩几处没包
node web/scripts/i18n-check.mjs --dict               # 只查字典：冲突、占位符、风格
node web/scripts/i18n-check.mjs <文件…> --compile     # 顺带用 svelte 编译器编一遍（抓语法错误）
cd harness && node web/scripts/svelte-baseline.ts     # dimensio 的类型检查（改了 harness/web 必跑）
```

- `LEFTOVER` 界面可见的中文没包；`MISSING` 键不在对应字典；`SHADOW` 局部变量 / 参数 / each 别名叫 `t`（或 `tc`、`tr`），
  会遮住翻译函数——改名，或者 `import { t as tt }` 后用 `tt()`；`DICT` 冲突 / 占位符不一致 / 英文里夹中文；
  `DYNAMIC` 键不是字面量；`STYLE` 风格提醒（直撇号、`...`、中文标点）。

## 5. 预览英文

地址后加 `?lang=en` 临时看英文（不改偏好）；设置里切换则持久。改完用浏览器在手机宽度（390px）、
平板（820px）、桌面（1440px）三档各看一眼：英文比中文长 1.5～2.5 倍，按钮、芯片、tab、表头最容易溢出。
