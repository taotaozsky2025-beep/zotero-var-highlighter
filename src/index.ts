import { config } from "../package.json";
import Addon from "./addon";

// @ts-expect-error - Plugin instance is not typed
if (!Zotero[config.addonInstance]) {
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = new Addon();
}
