# Copilot Instructions for Zotero Var Highlighter

## Project Overview

This is a **Zotero 7 plugin** that highlights selected variables/text across PDF documents, built on `zotero-plugin-scaffold` and `zotero-plugin-toolkit`. The plugin uses Zotero's PDF.js-based reader APIs to search and highlight text occurrences.

## Architecture

### Entry Flow

1. **[addon/bootstrap.js](addon/bootstrap.js)** → Zotero loads this first, injects sandbox context, then calls hooks
2. **[src/index.ts](src/index.ts)** → Creates singleton `Addon` instance on `Zotero[config.addonInstance]`
3. **[src/hooks.ts](src/hooks.ts)** → Lifecycle hooks (`onStartup`, `onMainWindowLoad`) - dispatch only, no business logic
4. **[src/modules/highlighter.ts](src/modules/highlighter.ts)** → Core feature: PDF text selection → search → highlight

### Key Components

- **Highlighter class**: Static singleton registered via `Zotero.Reader.registerEventListener("renderTextSelectionPopup", ...)` to intercept text selection events
- **PDF.js integration**: Accesses `PDFViewerApplication` through `reader._iframeWindow.wrappedJSObject.PDFViewerApplication`
- **Preferences**: Stored via `Zotero.Prefs.get/set` with prefix from `package.json > config.prefsPrefix`

## Build & Development

```bash
npm start          # Dev mode: build + watch + hot reload in Zotero
npm run build      # Production build → .scaffold/build/
npm run lint:fix   # Prettier + ESLint auto-fix
npm test           # Run tests in Zotero environment
```

Build output: `.scaffold/build/addon/` → esbuild bundles `src/index.ts` → `content/scripts/{addonRef}.js`

## Key Conventions

### Configuration (package.json > config)

```json
{
  "addonName": "Zotero Var Highlighter",
  "addonID": "zotero-var-highlighter@zotero-var-highlighter",
  "addonRef": "zotero-var-highlighter", // Used for chrome:// paths
  "addonInstance": "ZoteroVarHighlighter", // Global: Zotero.ZoteroVarHighlighter
  "prefsPrefix": "extensions.zotero.zotero-var-highlighter"
}
```

### Preferences Pattern

- Define defaults in [addon/prefs.js](addon/prefs.js): `pref("keyName", defaultValue);`
- Access via [src/utils/prefs.ts](src/utils/prefs.ts): `getPref("keyName")` / `setPref("keyName", value)`
- UI bindings in [addon/content/preferences.xhtml](addon/content/preferences.xhtml) with `preference="keyName"`

### Localization (Fluent)

- Files: `addon/locale/{en-US,zh-CN}/*.ftl`
- Use `data-l10n-id` in XHTML, programmatic access via `Zotero.getString()` or toolkit helpers

### Debugging

```typescript
Zotero.debug(`[${config.addonName}] message`); // Logs to Zotero console
new Zotero.ProgressWindow()
  .changeHeadline("Title")
  .addDescription("msg")
  .show(); // Visual popup
```

## PDF.js Access Pattern (Critical)

```typescript
// Get PDF.js application from reader
const iframeWin = reader._iframeWindow;
const app = iframeWin?.wrappedJSObject?.PDFViewerApplication;
const findController = app?.findController;

// Trigger search
findController.executeCommand("find", {
  query,
  highlightAll: true,
  caseSensitive: true,
});
```

## File Naming

- Modules: `src/modules/{feature}.ts` - class-based, static or instantiated
- Utils: `src/utils/{utility}.ts` - pure functions
- Build placeholders in addon files: `__addonRef__`, `__addonName__`, etc. → replaced by scaffold

## Testing

Tests run inside actual Zotero via `zotero-plugin-scaffold`. See [test/startup.test.ts](test/startup.test.ts) for example using Mocha + Chai.
