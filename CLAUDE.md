# Zotero Var Highlighter — 代码库说明

## 项目概述

一个 Zotero 7 插件，用于在 PDF 阅读器中高亮选中文本。当用户在 PDF 中选中任意文本时，插件会：
1. 高亮 **所有出现位置**（通过 PDF.js find，显示为橙色/黄色）。
2. 将 **全文第一次出现** 的位置强制设为"当前匹配"（显示为绿色），通常对应变量的定义处。

使用场景：研究人员阅读数学公式密集的论文时，快速追踪变量定义位置。

---

## 技术栈

- **语言**：TypeScript（通过 esbuild 编译为兼容 Firefox 115 的 JS）
- **插件框架**：`zotero-plugin-toolkit` + `zotero-plugin-scaffold`
- **PDF 引擎**：PDF.js（内置于 Zotero，通过 `PDFViewerApplication` 访问）
- **构建产物**：可安装到 Zotero 6.999–8.* 的 XPI 文件

---

## 项目结构

```
addon/
  bootstrap.js            # Firefox bootstrap 入口：install/startup/shutdown 生命周期
  manifest.json           # 插件清单（构建时填充模板占位符）
  prefs.js                # 默认偏好设置值
  content/
    preferences.xhtml     # 设置面板 UI（启用开关 + 输入框）
    icons/                # 插件图标
  locale/
    en-US/                # 英文字符串（.ftl）
    zh-CN/                # 简体中文字符串（.ftl）

src/
  index.ts                # 在 Zotero 全局对象上创建 Addon 单例
  addon.ts                # Addon 类：保存全局状态（config, ztoolkit）+ 启动通知
  hooks.ts                # 生命周期钩子分发：onStartup 调用 Highlighter.activate()
  modules/
    highlighter.ts        # 核心：所有 PDF 高亮逻辑均在此实现
  utils/
    locale.ts             # 语言/本地化辅助工具
    prefs.ts              # getPref / setPref / clearPref 封装
    window.ts             # 窗口工具
    ztoolkit.ts           # ZoteroToolkit 初始化及日志配置

typings/
  global.d.ts             # 全局类型声明
  prefs.d.ts              # 自动生成的偏好设置类型映射
  i10n.d.ts               # 本地化类型

zotero-plugin.config.ts   # Scaffold 构建配置（入口、输出路径、define 变量）
package.json              # npm 配置、插件元数据、addonRef/addonID/addonInstance
```

---

## 核心架构

### 启动流程

```
bootstrap.js startup()
  └─ 加载 content/scripts/zotero-var-highlighter.js（编译后的 bundle）
  └─ 调用 Zotero.ZoteroVarHighlighter.hooks.onStartup()
        └─ hooks.ts: onStartup()
              └─ 等待 Zotero ready promises（initializationPromise / unlockPromise / uiReadyPromise）
              └─ Highlighter.activate(addon)   ← 注册事件监听器
              └─ addon.addToWindow()           ← 显示启动通知
```

### 高亮事件流程

```
用户在 PDF 阅读器中选中文本
  └─ Zotero.Reader 触发 "renderTextSelectionPopup"
        └─ Highlighter.onRenderTextSelectionPopup(evt)
              1. 提取选中文本（从 evt.params 或 iframe Selection API）
              2. 校验：非空、长度 ≤ 100
              3. 通过 reader._iframeWindow.wrappedJSObject 获取 PDFViewerApplication
              4. 捕获当前滚动位置（captureScroll）
              5. 锁定滚动，阻止 PDF.js 自动跳转（lockScroll）
              6. 清除之前的高亮（clearPdfJsFind）
              7. 向 PDF.js eventBus 分发 "find" 事件（highlightAll=true, caseSensitive=true）
              8. 延迟 200ms 后：强制第一次出现为当前匹配（forceGlobalFirstAsCurrentMatch）
              9. 延迟 120ms 后：读取 find 状态（仅用于调试日志）
```

---

## 核心文件：`src/modules/highlighter.ts`

所有插件逻辑均位于静态类 `Highlighter` 中。

### 重要常量

| 常量 | 默认值 | 用途 |
|---|---|---|
| `CASE_SENSITIVE` | `true` | 严格区分大小写，防止 Φ/φ 混淆 |
| `PREVENT_SCROLL` | `true` | 阻止 PDF.js 自动滚动到匹配位置 |
| `SCROLL_LOCK_MS` | `1200` | 触发 find 后滚动锁定的持续时间（毫秒） |
| `AFTER_FIND_FORCE_FIRST_DELAY_MS` | `200` | 触发强制首匹配前的等待时间（毫秒） |
| `DEBUG_POPUP` | `false` | 设为 `true` 可开启调试用 ProgressWindow 弹窗 |
| `POPUP_THROTTLE_MS` | `0` | 调试弹窗的节流间隔 |

### 关键方法

- `activate(addon)` — 注册 `renderTextSelectionPopup` 事件监听器
- `deactivate()` — 注销监听器（插件关闭时调用）
- `getPdfJsApp(reader)` — 从 reader 的 iframe 中提取 `PDFViewerApplication`
- `dispatchEventBus(app, w, name, payload)` — 通过 `w.JSON.parse(JSON.stringify(...))` 跨沙盒边界向 PDF.js eventBus 发送事件
- `clearPdfJsFind(app, w)` — 调用 `findController.reset()` 或分发空 find 事件来清除高亮
- `captureScroll(app)` — 从 `pdfViewer.container` 读取当前滚动位置
- `lockScroll(app, snap, durationMs)` — 将 `scrollMatchIntoView` 和 `scrollPageIntoView` 临时替换为空操作，超时后恢复
- `forceGlobalFirstAsCurrentMatch(app)` — 直接修改 `findController._selected` 和 `_offset`，指向第一个有匹配的页面的 `pageIdx=0, matchIdx=0`

### 跨沙盒注意事项

PDF.js 运行在 Firefox 沙盒中。在 Zotero JS 上下文中创建的对象无法直接传递给 PDF.js 内部。所有通过 `eventBus.dispatch` 发送的数据必须经由 iframe 自身的 `JSON` 进行序列化：`w.JSON.parse(JSON.stringify(payload))`。

---

## 偏好设置

两个偏好项（主要为模板脚手架残留，高亮器当前未使用）：

| 键名 | 类型 | 默认值 |
|---|---|---|
| `extensions.zotero.zotero-var-highlighter.enable` | boolean | `true` |
| `extensions.zotero.zotero-var-highlighter.input` | string | `"This is input"` |

---

## 构建与开发命令

```bash
npm start        # 热重载开发模式（zotero-plugin serve）
npm run build    # 构建 XPI + 类型检查（zotero-plugin build && tsc --noEmit）
npm run lint:fix # 自动修复格式和 lint 问题
npm test         # 通过 zotero-plugin test 运行测试
npm run release  # 创建发布版本
```

构建产物输出到 `.scaffold/build/`。编译后的 JS bundle 输出路径为：
`addon/content/scripts/zotero-var-highlighter.js`

构建时模板占位符（如 `__addonRef__`、`__addonInstance__`、`__buildVersion__`）由 `zotero-plugin-scaffold` 根据 `package.json` 中的值替换。

---

## 新增功能指引

- **修改高亮行为**：修改 [src/modules/highlighter.ts](src/modules/highlighter.ts) 中的 `onRenderTextSelectionPopup`
- **新增偏好设置**：在 `typings/prefs.d.ts` 和 `addon/prefs.js` 中添加，然后通过 [src/utils/prefs.ts](src/utils/prefs.ts) 的 `getPref`/`setPref` 访问
- **新增 UI 元素**：修改 [addon/content/preferences.xhtml](addon/content/preferences.xhtml) 并更新对应的 locale FTL 文件
- **新增生命周期钩子**：在 [src/hooks.ts](src/hooks.ts) 中添加，并在对应模块中实现

---

## 已知局限性

- `forceGlobalFirstAsCurrentMatch` 依赖 PDF.js 内部字段（`_selected`、`_offset`、`_updateMatch`），这些字段可能随 Zotero 内置 PDF.js 版本更新而变化，属于 best-effort 实现。
- 滚动锁定临时 patch 了 PDF.js 内部方法；若 Zotero 更新 PDF.js 导致方法名变化，需同步更新。
- 文本选择检测依赖 `reader._iframeWindow`，这是 Zotero 的私有 API。

## 踩过的坑（避免重蹈覆辙）

- **持续监听 `scroll` 事件回滚 scrollTop 会拦截用户主动滚动** —— 用户感觉"被锁定/反复拉回"。正确做法：只在 `_updateMatch(true)` 调用瞬间同步 save/restore，不持久监听。
- **`wheel` / `keydown` 在 Zotero reader 中收不到** —— 哪怕 capture phase + iframe window 级监听都无效，原因不明（疑似 XUL 嵌套结构）。不要把"用户输入信号"作为解锁依据。
- **`npm start` 热重载多次后会静默失效** —— bundle 编译成功、`Last extension reload` 日志正常，但事件 handler 完全不触发。怀疑代码不生效时，第一步是在 `activate()` 和 handler 入口加强制 `Zotero.ProgressWindow` 弹版本号，肉眼确认。彻底验证需 kill `zotero.exe` 让 dev server 冷启动。
- **`onShutdown` 默认是空的，没调用 `Highlighter.deactivate()`** —— 旧 handler 不会被 unregister，热重载累积是失效根因之一。

---

## Hover Preview 实现（v0.2.0）

### 功能概述

用户鼠标悬停在任一高亮匹配（非首匹配绿色）≥350ms，弹出浮窗显示该匹配首次出现处的页面预览。类似 Zotero 原生的"章节预览"或"链接预览"。

### 核心设计

**根本问题**：Zotero reader 的 iframe 是**嵌套的**：
- 外层 `reader._iframeWindow`（暴露 `PDFViewerApplication`）
- 内层 PDF.js viewer.html（真正承载 `.textLayer`、`.highlight`、page canvas）

之前的实现误用外层 doc，导致 popup 注入错位、mouseover 监听无效、`drawImage(pageCanvas, …)` 跨 realm 崩溃。

**修复方案**（`src/modules/hover-preview.ts`）：

| 步骤 | 实现 |
|---|---|
| 1. 定位内层 doc | `getPdfInnerDoc(app, reader)` —— 链式尝试 `pdfViewer.container.ownerDocument` / `viewer.ownerDocument` / `appConfig.mainContainer.ownerDocument` / `_pages[0].div.ownerDocument`，最后兜底 `reader._iframeWindow.document` |
| 2. 所有 DOM 操作在内层 doc 执行 | popup `<div>` / `<canvas>` 创建、style 注入、`mouseover/mouseout` listener、`scroll/resize` listener 均使用 `innerDoc` |
| 3. 等比缩放渲染 | 横向取整页宽（不做窄裁切），纵向以首匹配为中心（上 40% / 下 60%）截出一段段；缩放到 popup max（560×680），绝不非等比拉伸 |
| 4. 防御式访问 | 每次 hover 重新解析 app、pageView、canvas，不缓存；每个 PDF.js 访问点单独 try/catch |
| 5. 生命周期注册 | `hooks.ts` 中 `onStartup` 调 `HoverPreview.activate()`，`onShutdown` 调 `deactivate()`；Highlighter 在 `onFindCommitted`/`onFindCleared` 时回调 HoverPreview |

### 集成点

- [src/modules/hover-preview.ts](src/modules/hover-preview.ts) —— 完整实现
- [src/modules/highlighter.ts:57](src/modules/highlighter.ts#L57) —— `ENABLE_HOVER_PREVIEW = true` 开启功能
- [src/modules/highlighter.ts:172](src/modules/highlighter.ts#L172) —— 新选中时 `HoverPreview.onFindCleared(reader)`
- [src/modules/highlighter.ts:1244](src/modules/highlighter.ts#L1244) —— find 稳定后 `HoverPreview.onFindCommitted(reader, ctx)`
- [src/hooks.ts:26,71](src/hooks.ts#L26) —— `HoverPreview.activate()` / `deactivate()`

### 常量配置

| 常量 | 值 | 用途 |
|---|---|---|
| `HOVER_DELAY_MS` | 350 | 悬停多久后显示 popup |
| `REENTRY_GRACE_MS` | 120 | 离开后多久真正隐藏（容纳快速移动） |
| `POPUP_MAX_WIDTH_PX` | 560 | popup 最大宽 |
| `POPUP_MAX_HEIGHT_PX` | 680 | popup 最大高 |
| `POPUP_MIN_WIDTH_PX` | 280 | popup 最小宽（极端窄文本时) |
| `VERTICAL_FOCUS_RATIO` | 0.4 | 纵向裁切时 match 上方占比 |

### 测试检查清单

1. **冷启动**（绝不用热重载）：关闭 Zotero，重装 XPI，重启
2. **基线回归**：选变量 → 全文首处绿色、其他处橙色
3. **核心功能**：鼠标停在橙色高亮 ≥350ms → popup 显示首处所在页的完整宽、中等高的截图
4. **排除首匹配**：鼠标停在绿色（首匹配）高亮 → 不弹 popup
5. **压力**：popup 显示中，scroll / 缩放 / 切文档 / 关闭 reader → 无闪退、popup 干净消失
6. **日志**：Zotero debug console 搜 `[zotero-var-highlighter:hover]` → 仅正常日志，无 EXCEPTION
