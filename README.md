# Zotero Var Highlighter

[![zotero target version](https://img.shields.io/badge/Zotero-7--9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)](https://github.com/taotaozsky2025-beep/zotero-var-highlighter/releases/latest)
[![Using Zotero Var Highlighter](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[Chinese Version 简体中文](doc/README-zhCN.md)

---

[Download Latest XPI](https://github.com/taotaozsky2025-beep/zotero-var-highlighter/releases/latest/download/zotero-var-highlighter.xpi)

## Overview

**Zotero Var Highlighter** is a plugin designed to assist researchers in reading complex papers, particularly those heavy with mathematical variables or specific terminologies. Select any text in the PDF reader and the plugin instantly highlights every occurrence across the entire document — and visually marks the **first occurrence** (typically the definition) in a distinct color.

## Features

### Auto-Highlighting

When you **select any text** (a variable name, symbol, or keyword) in the Zotero PDF Reader, the plugin automatically:

1. **Captures** the selected text.
2. **Searches** the entire PDF document for all occurrences.
3. **Highlights** every match in orange/yellow.
4. **Marks the first occurrence** in green — the place where the variable is usually defined.

### Hover Preview *(v0.2.0)*

Hover your mouse over any **non-first-occurrence highlight** (orange) for more than 350 ms to see a **popup preview** of the page where the first occurrence appears. This lets you instantly peek at the definition without navigating away from your current reading position.

- Hover over a first-occurrence highlight (green) does **not** trigger the popup.
- The popup disappears as soon as you move the cursor away.

### Customizable Settings *(v0.2.0)*

Open **Zotero → Settings → Zotero Var Highlighter** to adjust:

| Setting | Description | Default |
|---|---|---|
| First-match color | Color for the first occurrence highlight | Green `#00b450` |
| First-match opacity | Opacity of the first occurrence highlight | 55% |
| Other-match color | Color for all other occurrence highlights | Orange `#ff9e00` |
| Other-match opacity | Opacity of other occurrence highlights | 45% |
| Preview max width | Maximum width of the hover preview popup (px) | 800 |
| Preview max height | Maximum height of the hover preview popup (px) | 500 |
| Hover delay | Time to hover before the preview appears (ms) | 350 |

## Screenshot

![Zotero Var Highlighter in action](image.png)

*Green highlight marks the first occurrence (variable definition); orange highlights mark all other occurrences.*

## Compatibility

| Zotero Version | Status |
|---|---|
| Zotero 7 | Supported |
| Zotero 8 | Supported |
| Zotero 9 | Supported *(added in v0.2.0)* |

## Usage

1. Install the XPI file in Zotero (**Tools → Plugins → Install Plugin From File**).
2. Open any PDF in the Zotero reader.
3. Select a word or symbol with your mouse — highlighting appears instantly.
4. Hover over any orange highlight to preview the definition location.

## Changelog

### v0.2.0
- **New**: Hover preview — hover over an orange highlight to see a popup showing the first occurrence of the selected text.
- **New**: Customizable highlight colors, opacity, and preview window size via Settings.
- **New**: Zotero 9 support.
- **Improved**: Cold-start optimization — the plugin now warms up the PDF.js reader before the first selection to prevent scroll-jumping on initial use.

### v0.1.0
- Initial release.
- Auto-highlight all occurrences of selected text across the entire PDF.
- First-occurrence marker (green) to locate variable definitions.
