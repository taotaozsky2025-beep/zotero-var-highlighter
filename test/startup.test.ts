import { assert } from "chai";
import { config } from "../package.json";

async function waitFor(check: () => any, message: string, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = check();
    if (result) return result;
    await Zotero.Promise.delay(100);
  }
  throw new Error(message);
}

function makeTestPDF() {
  const streams = [
    "BT /F1 18 Tf 50 720 Td (ZVHprobe defines a variable.) Tj 0 -40 Td (ZVHprobe is used again.) Tj 0 -40 Td (ZVHother is another variable.) Tj ET",
    "BT /F1 18 Tf 50 720 Td (ZVHprobe appears on page two.) Tj ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.map(
      (stream) =>
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  return (
    pdf +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  );
}

describe("startup and toolkit security", function () {
  it("finishes startup with the toolkit helpers available", function () {
    const instance = Zotero[config.addonInstance];
    assert.isTrue(instance.data.initialized);
    assert.isFunction(instance.data.ztoolkit.ProgressWindow.setIconURI);
    assert.exists(instance.data.ztoolkit.UI);
    Zotero.debug(`[ZVH test] Running in Zotero ${Zotero.version}`);
  });

  it("does not register toolkit installation or debug protocols", function () {
    const io = Components.classes[
      "@mozilla.org/network/io-service;1"
    ].getService(Components.interfaces.nsIIOService);
    const extensions = (io.getProtocolHandler("zotero") as any).wrappedJSObject
      ._extensions;
    assert.notProperty(extensions, "zotero://plugin");
    assert.notProperty(extensions, "zotero://ztoolkit-debug");
  });
});

describe("PDF highlighting and hover preview", function () {
  this.timeout(90000);
  let attachment: any;
  let temporaryFile: any;
  let reader: any;
  let app: any;
  let doc: Document;

  before(async function () {
    temporaryFile = Zotero.getTempDirectory();
    temporaryFile.append(`zvh-toolkit6-${Date.now()}.pdf`);
    await Zotero.File.putContentsAsync(temporaryFile, makeTestPDF());
    attachment = await Zotero.Attachments.importFromFile({
      file: temporaryFile.path,
      libraryID: Zotero.Libraries.userLibraryID,
    });
    reader = await Zotero.Reader.open(attachment.id);
    app = await waitFor(
      () => {
        const outer = reader?._iframeWindow;
        const candidate = (outer?.wrappedJSObject ?? outer)?.PDFViewerApplication;
        return candidate?.pdfDocument && candidate?.pdfViewer?.container
          ? candidate
          : null;
      },
      "PDF.js reader did not initialize",
    );
    doc = app.pdfViewer.container.ownerDocument;
    await waitFor(
      () => doc.querySelector(".textLayer span"),
      "PDF text layer did not render",
    );
  });

  after(async function () {
    if (reader) await reader.close();
    if (attachment) await attachment.eraseTx();
    if (temporaryFile?.exists()) temporaryFile.remove(false);
  });

  it("highlights matches on both pages and marks the global first match", async function () {
    (Zotero.Reader as any)._dispatchEvent({
      type: "renderTextSelectionPopup",
      reader,
      doc,
      params: { text: "ZVHprobe" },
      append: () => {},
    });
    await waitFor(
      () => {
        const matches = app.findController?.pageMatches;
        return matches?.[0]?.length === 2 && matches?.[1]?.length === 1;
      },
      "Expected two matches on page one and one on page two",
    );
    await waitFor(
      () => doc.querySelector(".zvh-global-first-match"),
      "The first occurrence was not marked",
    );
    assert.isAtLeast(doc.querySelectorAll(".textLayer .highlight").length, 2);
    assert.exists(doc.querySelector(".zvh-hover-preview[hidden]"));
  });

  it("previews a non-first occurrence and hides the preview on mouseout", async function () {
    const target = await waitFor(
      () =>
        doc.querySelector(
          ".textLayer .highlight:not(.zvh-global-first-match):not(.selected)",
        ),
      "No non-first highlight was rendered",
    );
    const win = doc.defaultView as any;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new win.MouseEvent("mouseover", {
        bubbles: true,
        clientX: rect.left + 1,
        clientY: rect.top + 1,
      }),
    );
    const popup = await waitFor(
      () => doc.querySelector(".zvh-hover-preview:not([hidden])"),
      "Hover preview did not appear",
    );
    const canvas = popup.querySelector("canvas") as HTMLCanvasElement;
    assert.isAbove(canvas.width, 0);
    assert.isAbove(canvas.height, 0);
    target.dispatchEvent(
      new win.MouseEvent("mouseout", {
        bubbles: true,
        relatedTarget: doc.body,
      }),
    );
    await waitFor(
      () => popup.hasAttribute("hidden"),
      "Hover preview did not disappear",
    );
  });

  it("replaces the old highlights when a different variable is selected", async function () {
    (Zotero.Reader as any)._dispatchEvent({
      type: "renderTextSelectionPopup",
      reader,
      doc,
      params: { text: "ZVHother" },
      append: () => {},
    });
    await waitFor(
      () => {
        const matches = app.findController?.pageMatches;
        return matches?.[0]?.length === 1 && matches?.[1]?.length === 0;
      },
      "Selecting a new variable did not replace the old search",
    );
    const first = await waitFor(
      () => doc.querySelector(".zvh-global-first-match"),
      "The new variable's first occurrence was not marked",
    );
    assert.include(first.textContent || "", "ZVHother");
  });
});
