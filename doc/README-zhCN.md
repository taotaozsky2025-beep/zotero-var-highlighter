# Zotero Var Highlighter

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Var Highlighter](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

---

## 简介

**Zotero Var Highlighter** 是一款旨在辅助研究人员阅读复杂论文的插件，特别是那些包含大量数学变量的论文。它可以在整篇论文中高亮所选字符。
[下载最新安装包XPI](https://github.com/taotaozsky2025-beep/zotero-var-highlighter/releases/latest/download/zotero-var-highlighter.xpi)

## 核心功能

### 自动高亮

当你在 Zotero PDF 阅读器中**选中任何文本**（例如变量名、符号或关键词）时，插件会自动执行以下操作：

1.  **获取**选中的文本。
2.  **搜索**整个 PDF 文档中该文本的所有出现位置。
3.  **高亮**显示每一个匹配项，并以不同颜色区分：
    - **全文第一次出现**（通常是定义处）以**绿色**高亮显示（可自定义）。
    - **其他所有出现位置**以**粉色**高亮显示（可自定义）。

### 首次出现预览

当您将鼠标悬停在任何高亮文本上时，会弹出一个**预览窗口**，显示：

- 该变量在文档中首次定义的页码。
- 该页面的缩略图预览。
- 点击弹窗可直接跳转到定义页面。

### 自定义高亮颜色

您可以在插件设置中自定义高亮颜色：

- **首次出现颜色**：文档中第一次出现（定义处）的颜色（默认：绿色）。
- **其他匹配颜色**：所有其他出现位置的颜色（默认：粉色）。

### 使用场景

这在阅读学术论文时非常有用。例如，当你在第 10 页遇到一个变量（如 $\hbar$）时，无需手动打开搜索栏，即可快速回顾它的定义位置或查看它在文中其他出现的地方。

## 使用方法

只需在 Zotero 中打开 PDF，使用鼠标选中一个单词或变量，高亮即可自动完成。

## 设置

通过 `编辑 > 设置 > Zotero Var Highlighter` 访问插件设置，可自定义：

- 启用/禁用插件
- 设置首次出现和其他匹配的自定义颜色
