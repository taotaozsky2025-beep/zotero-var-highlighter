/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

function install(data, reason) {}

function ZVH_alert(msg) {
  try {
    Services.prompt.alert(null, "ZVH bootstrap", String(msg));
  } catch (e) {}
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  ZVH_alert("startup() entered");

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);

  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  ZVH_alert("registerChrome OK");

  // 安全 console：避免你之前的 console is not defined
  const safeConsole = (typeof console !== "undefined" && console) || {
    log: (...args) => Zotero.debug(args.map(String).join(" ")),
    info: (...args) => Zotero.debug(args.map(String).join(" ")),
    warn: (...args) => Zotero.debug(args.map(String).join(" ")),
    error: (...args) => {
      try {
        Zotero.logError(
          args[0] instanceof Error
            ? args[0]
            : new Error(args.map(String).join(" ")),
        );
      } catch (e) {
        Zotero.debug("console.error fallback: " + String(e));
      }
    },
  };

  // 关键：把 Zotero / Services / Components 注入 sandbox
  const ctx = {
    rootURI,
    Zotero,
    Services,
    Components,
    console: safeConsole,
    setTimeout,
    clearTimeout,
  };
  ctx._globalThis = ctx;

  // 关键：去掉 rootURI 后面的额外斜杠
  const entry = `${rootURI}content/scripts/__addonRef__.js`;

  try {
    ZVH_alert("loadSubScript begin: " + entry);
    Services.scriptloader.loadSubScript(entry, ctx);
    ZVH_alert("loadSubScript OK");
  } catch (e) {
    ZVH_alert("loadSubScript FAILED: " + e);
    try {
      Zotero.logError(e);
    } catch (_) {}
    return; // 必须 return，否则继续抛更难读的错误
  }

  try {
    ZVH_alert("calling hooks.onStartup()");
    await Zotero.__addonInstance__.hooks.onStartup();
    ZVH_alert("hooks.onStartup() OK");
  } catch (e) {
    ZVH_alert("hooks.onStartup() FAILED: " + e);
    try {
      Zotero.logError(e);
    } catch (_) {}
  }
}

async function onMainWindowLoad({ window }, reason) {
  Zotero.debug("[ZVH] onMainWindowLoad");
  const progressWin = new Zotero.ProgressWindow();
  progressWin.changeHeadline("加载成功");
  progressWin.show();
  progressWin.startCloseTimer(3000);

  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
