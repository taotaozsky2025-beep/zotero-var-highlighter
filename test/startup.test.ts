import { assert } from "chai";
import { config } from "../package.json";

describe("startup and toolkit security", function () {
  it("finishes startup with the toolkit helpers available", function () {
    const instance = Zotero[config.addonInstance];
    assert.isTrue(instance.data.initialized);
    assert.isFunction(instance.data.ztoolkit.ProgressWindow.setIconURI);
    assert.exists(instance.data.ztoolkit.UI);
    Zotero.debug(`[ZVH test] Running in Zotero ${Zotero.version}`);
  });

  it("does not register toolkit installation or debug protocols", function () {
    const classes = Components.classes;
    const service = classes["@mozilla.org/network/io-service;1"];
    const io = service.getService(Components.interfaces.nsIIOService);
    const protocol = io.getProtocolHandler("zotero") as any;
    const extensions = protocol.wrappedJSObject._extensions;
    const forbidden = Object.keys(extensions).filter(
      (key) => key === "zotero://plugin" || key === "zotero://ztoolkit-debug",
    );
    (globalThis as any).debug({
      zoteroVersion: Zotero.version,
      toolkitVersion: Zotero[config.addonInstance].data.ztoolkit._version,
      protocolKeys: Object.keys(extensions),
      installHandlerType: typeof extensions["zotero://plugin"],
      debugHandlerType: typeof extensions["zotero://ztoolkit-debug"],
    });
    assert.deepEqual(forbidden, []);
    assert.isUndefined(extensions["zotero://plugin"]);
    assert.isUndefined(extensions["zotero://ztoolkit-debug"]);
  });
});
