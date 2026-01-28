import { SearchEngine } from "./searchEngine";
import { DefinitionAnalyzer } from "./definitionAnalyzer";

type Reader = any;

export class Highlighter {
  private static readonly HIGHLIGHT_COLOR = "#FDE456"; // A yellow-ish color
  private static readonly HIGHLIGHT_TYPE = "zotero-var-highlighter-search";
  private static currentReader?: Reader;
  private static addon: any;

  /**
   * Activates the highlighter functionality by setting up event listeners for reader events.
   * @param addon The main addon instance.
   */
  public static activate(addon: any) {
    this.addon = addon;
    this.addon.data.ztoolkit.log("Highlighter activated");

    // Use a notifier to watch for when a reader is selected
    this.addon.data.ztoolkit.UI.Notifier.register(
      "reader-select",
      this.onReaderSelect,
      ["reader"],
      this.addon.data.config.addonRef,
    );
  }

  /**
   * Handles the 'reader-select' event.
   * @param reader The reader instance that was selected.
   */
  private static onReaderSelect = (reader: Reader) => {
    if (this.currentReader) {
      this.deactivateReader(this.currentReader);
    }
    this.currentReader = reader;
    this.activateReader(reader);
  };

  /**
   * Attaches event listeners to a specific reader instance.
   * @param reader The reader instance.
   */
  private static activateReader(reader: Reader) {
    this.addon.data.ztoolkit.log(`Attaching to reader: ${reader.id}`);
    if (reader.isViewerLoaded) {
      this.onViewerLoaded(reader);
    } else {
      reader.on("viewerLoaded", () => this.onViewerLoaded(reader));
    }
  }

  /**
   * Detaches event listeners from a reader instance.
   * @param reader The reader instance.
   */
  private static deactivateReader(reader: Reader) {
    this.addon.data.ztoolkit.log(`Detaching from reader: ${reader.id}`);
    reader.off("viewerLoaded", () => this.onViewerLoaded(reader));
    if (reader.isViewerLoaded) {
      reader.contentWindow?.removeEventListener("mouseup", this.onMouseUp);
    }
  }

  /**
   * Attached when the reader's internal PDF viewer is ready.
   * @param reader The reader instance.
   */
  private static onViewerLoaded = (reader: Reader) => {
    if (!reader.isViewerLoaded) return;
    this.addon.data.ztoolkit.log(
      "Reader viewer loaded. Attaching event listeners.",
    );
    reader.contentWindow?.addEventListener("mouseup", (e: MouseEvent) =>
      this.onMouseUp(e, reader),
    );
  };

  /**
   * Handles the mouseup event to detect text selection.
   */
  private static onMouseUp = async (event: MouseEvent, reader: Reader) => {
    if ((event.target as HTMLElement)?.closest(".textLayer") === null) {
      return;
    }

    const selection = reader.contentWindow?.getSelection();
    const selectedText = selection?.toString().trim();

    if (!selectedText) {
      return;
    }

    this.addon.data.ztoolkit.log(`Text selected: "${selectedText}"`);
    await this.clearHighlights(reader);

    try {
      const occurrences = await SearchEngine.searchAll(
        this.addon,
        reader,
        selectedText,
      );
      if (!occurrences || occurrences.length === 0) {
        this.addon.data.ztoolkit.log(
          `No occurrences found for "${selectedText}"`,
        );
        return;
      }

      const definition = await DefinitionAnalyzer.analyze(
        this.addon,
        reader,
        selectedText,
        occurrences,
      );

      await reader.renderHighlight(
        occurrences,
        Highlighter.HIGHLIGHT_COLOR,
        "",
        Highlighter.HIGHLIGHT_TYPE,
      );

      Zotero.debug(
        `[zotero-var-highlighter] Variable: ${selectedText}, Count: ${occurrences.length}, Definition: ${definition}`,
      );
    } catch (error: any) {
      this.addon.data.ztoolkit.log(error, "error");
    }
  };

  /**
   * Clears all highlights created by this plugin in a given reader.
   * @param reader The reader instance.
   */
  private static async clearHighlights(reader: Reader) {
    if (!reader.isViewerLoaded) return;
    try {
      await reader.removeAnnotationsOfType(Highlighter.HIGHLIGHT_TYPE);
    } catch (error: any) {
      this.addon.data.ztoolkit.log(error, "error");
    }
  }
}
