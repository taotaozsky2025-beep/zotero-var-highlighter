# Zotero Var Highlighter

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Var Highlighter](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[简体中文](doc/README-zhCN.md)

---

# Zotero Var Highlighter Documentation

[Download Latest XPI](https://github.com/taotaozsky2025-beep/zotero-var-highlighter/releases/latest/download/zotero-var-highlighter.xpi)

## Overview

**Zotero Var Highlighter** is a plugin designed to assist researchers in reading complex papers, particularly those heavy with mathematical variables or specific terminologies. It can highlight selected characters throughout the entire paper.

## Core Functionality

### Auto-Highlighting

When you **select any text** (such as a variable name, symbol, or keyword) in the Zotero PDF Reader, the plugin automatically:

1.  **Captures** the selected text.
2.  **Searches** the entire PDF document for all occurrences of that text.
3.  **Highlights** every matched text with a distinct color:
    - The **first occurrence** in the entire document (typically the definition) is highlighted in **green** (customizable).
    - All **other occurrences** are highlighted in **pink** (customizable).

### First Occurrence Preview

When you hover your mouse over any highlighted text, a **preview popup** appears showing:

- The page number where the variable is first defined in the document.
- A thumbnail preview of that page.
- Click on the popup to jump directly to the definition page.

### Custom Highlight Colors

You can customize the highlight colors in the plugin preferences:

- **First match color**: Color for the first occurrence (definition) in the document (default: green).
- **Other matches color**: Color for all other occurrences (default: pink).

### Use Case

This is particularly useful when reading academic papers where you encounter a variable (e.g., $\hbar$) on page 10 and need to quickly recall where it was defined or see where else it appears, without manually opening the search bar.

## Usage

Simply open a PDF in Zotero and use your mouse to select a word or variable. The highlighting happens automatically.

## Settings

Access the plugin settings via `Edit > Settings > Zotero Var Highlighter` to customize:

- Enable/disable the plugin
- Set custom colors for first occurrence and other matches
