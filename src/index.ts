import { BasicTool } from "zotero-plugin-toolkit";
import { config } from "../package.json";
import { Highlighter } from "./modules/highlighter";

const basicTool = new BasicTool();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = true;
  Highlighter.activate();
}
