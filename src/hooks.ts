import { Highlighter } from "./modules/highlighter";
import { config } from "../package.json";

async function onStartup() {
  Zotero.debug(`[${config.addonName}] onStartup: Begin`);

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  Zotero.debug(
    `[${config.addonName}] onStartup: Zotero ready promises resolved`,
  );
  try {
    // @ts-expect-error
    Highlighter.activate(Zotero[config.addonInstance]);
    Zotero.debug(`[${config.addonName}] Highlighter activated`);
  } catch (e) {
    Zotero.debug(`[${config.addonName}] ERROR activating Highlighter: ${e}`);
  }
  const mainWindow = Zotero.getMainWindow();
  Zotero.debug(
    `[${config.addonName}] onStartup: getMainWindow() result: ${mainWindow ? "Found" : "Null"}`,
  );

  if (mainWindow) {
    Zotero.debug(
      `[${config.addonName}] onStartup: Manually triggering onMainWindowLoad`,
    );
    await onMainWindowLoad(mainWindow);
  } else {
    Zotero.debug(
      `[${config.addonName}] onStartup: No main window found, waiting for event`,
    );
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  Zotero.debug(`[${config.addonName}] onMainWindowLoad: Called`);

  try {
    // @ts-expect-error
    Zotero[config.addonInstance].addToWindow(win);
    Zotero.debug(
      `[${config.addonName}] onMainWindowLoad: addToWindow executed`,
    );
  } catch (e) {
    Zotero.debug(`[${config.addonName}] ERROR in onMainWindowLoad: ${e}`);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {}

function onShutdown(): void {}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {}

function onShortcuts(type: string) {}

function onDialogEvents(type: string) {}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
