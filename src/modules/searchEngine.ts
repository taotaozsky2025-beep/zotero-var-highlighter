/**
 * Core search functionality for finding all occurrences of text in a PDF.
 * Relies on the Zotero 7 native PDF reader's search capabilities.
 */
export class SearchEngine {
    /**
     * Searches for all occurrences of a query string in the Zotero reader.
     * 
     * The search is case-insensitive by default in Zotero's reader.
     * 
     * @param addon The addon instance.
     * @param reader The Zotero reader instance.
     * @param query The string to search for.
     * @returns A promise that resolves to an array of search results (selections).
     *          Each result is an object that can be used directly by `reader.renderHighlight()`.
     *          It typically includes `pageIndex` and `rects`.
     */
    static async searchAll(addon: any, reader: any, query: string): Promise<any[]> {
        try {
            // Using Zotero 7's reader search API. The `{ all: true }` option ensures we get all results.
            const results = await reader.search(query, { all: true });
            return results;
        } catch (error: any) {
            addon.data.ztoolkit.log(error, 'error');
            return [];
        }
    }
}
