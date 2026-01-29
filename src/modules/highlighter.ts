type Reader = any;

type RenderTextSelectionPopupEvent = {
  reader?: Reader;
  doc?: Document;
  params?: any;
  append?: (node: Node) => void;
};

type ScrollSnapshot = {
  scrollTop: number;
  scrollLeft: number;
  pageNumber?: number;
};

export class Highlighter {
  // 版本指纹：用来确认你运行的就是这份文件
  private static readonly TAG = "ZVH-highlighter-2026-01-29-r5";

  // Debug
  private static readonly DEBUG_POPUP = true;
  private static readonly VERBOSE_ON_EARLY_RETURN = true;

  // 关键：调试期必须关节流，否则只看到第一条
  private static readonly POPUP_THROTTLE_MS = 0;

  // 行为开关（新增）
  private static readonly CASE_SENSITIVE = true; // 解决 Φ vs φ 等混淆
  private static readonly PREVENT_SCROLL = true; // 解决 find 导致的滚动
  private static readonly RESTORE_SCROLL_DELAY_MS = 80; // 允许 PDF.js 先处理 find，再恢复滚动

  private static debugSeq = 0;
  private static lastPopupAt = 0;

  private static addon: any;
  private static pluginID = "zotero-var-highlighter@local";

  // 稳定引用，便于 unregister
  private static readonly handler = (evt: RenderTextSelectionPopupEvent) => {
    void Highlighter.onRenderTextSelectionPopup(evt);
  };

  private static log(msg: string) {
    try {
      Zotero.debug(`[zotero-var-highlighter] ${msg}`);
    } catch {}
  }

  private static popup(step: string, detail?: string, ms = 1600) {
    if (!this.DEBUG_POPUP) return;

    const now = Date.now();
    if (now - this.lastPopupAt < this.POPUP_THROTTLE_MS) return;
    this.lastPopupAt = now;

    const seq = ++this.debugSeq;
    const headline = `ZVH Step ${seq}: ${step}`;
    const desc = detail ? String(detail) : "";

    // Debug Output（证据链）
    this.log(`${headline} ${desc}`);

    // 优先 ProgressWindow（右下角），失败就不影响主逻辑
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline(headline);
      if (desc) pw.addDescription(desc);
      pw.show();
      pw.startCloseTimer(ms);
    } catch {}
  }

  private static async delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  public static activate(addon: any) {
    this.addon = addon;
    this.pluginID = addon?.data?.config?.addonRef || addon?.id || this.pluginID;

    this.popup("activate()", `tag=${this.TAG} pluginID=${this.pluginID}`);

    try {
      Zotero.Reader.registerEventListener(
        "renderTextSelectionPopup",
        this.handler,
        this.pluginID,
      );
      this.popup("registerEventListener OK", "renderTextSelectionPopup");
    } catch (e) {
      this.popup("registerEventListener FAILED", String(e), 4500);
      throw e;
    }
  }

  public static deactivate() {
    this.popup("deactivate()", `tag=${this.TAG}`);
    try {
      Zotero.Reader.unregisterEventListener(
        "renderTextSelectionPopup",
        this.handler,
      );
      this.popup("unregisterEventListener OK");
    } catch (e) {
      this.popup("unregisterEventListener FAILED", String(e), 4500);
    }
  }

  private static async onRenderTextSelectionPopup(
    evt: RenderTextSelectionPopupEvent,
  ) {
    this.popup("renderTextSelectionPopup FIRED", `tag=${this.TAG}`);

    const reader = evt?.reader;
    if (!reader) {
      if (this.VERBOSE_ON_EARLY_RETURN)
        this.popup("return", "evt.reader is null");
      return;
    }

    // 1) 提取选中文本：先 params，再 fallback selection
    let selected = "";
    try {
      selected = String(
        evt?.params?.text ??
          evt?.params?.annotation?.text ??
          evt?.params?.annotationText ??
          "",
      ).trim();
    } catch {}

    this.popup("extract params text", selected ? `\`${selected}\`` : "(empty)");

    if (!selected) {
      // fallback：从 iframe selection 取
      try {
        const w0 = reader?._iframeWindow || reader?.contentWindow || null;
        const sel = w0?.getSelection?.();
        selected = String(sel?.toString?.() || "").trim();
      } catch {}
      this.popup(
        "fallback selection",
        selected ? `\`${selected}\`` : "(empty)",
      );
    }

    if (!selected) {
      if (this.VERBOSE_ON_EARLY_RETURN)
        this.popup("return", "selectedText empty", 2200);
      return;
    }

    // 规范化空白（注意：不要改变大小写/不要做 Unicode 归一化，以免引入混淆）
    selected = selected.replace(/\s+/g, " ").trim();
    this.popup("selectedText", `\`${selected}\` len=${selected.length}`);

    if (selected.length > 100) {
      if (this.VERBOSE_ON_EARLY_RETURN)
        this.popup("return", "selection too long (>100)", 2200);
      return;
    }

    // 2) 拿到 PDF.js app
    const { app, w } = this.getPdfJsApp(reader);
    this.popup(
      "getPdfJsApp()",
      `iframeWin=${!!reader?._iframeWindow} wrapped=${!!reader?._iframeWindow?.wrappedJSObject} app=${!!app}`,
      2200,
    );

    if (!app || !w) {
      if (this.VERBOSE_ON_EARLY_RETURN) {
        this.popup(
          "return",
          "PDFViewerApplication not found (not a PDF.js viewer?)",
          3000,
        );
      }
      return;
    }

    // 2.5) 保存滚动位置（用于阻止 find 自动滚动）
    let snap: ScrollSnapshot | null = null;
    if (this.PREVENT_SCROLL) {
      snap = this.captureScroll(app);
      this.popup(
        "captureScroll()",
        snap
          ? `top=${snap.scrollTop} left=${snap.scrollLeft} page=${snap.pageNumber ?? "?"}`
          : "FAILED",
        1800,
      );
    }

    // 3) 清理旧的 find 高亮（PDF.js 级别）
    const cleared = this.clearPdfJsFind(app, w);
    this.popup("clearPdfJsFind()", cleared ? "OK" : "SKIP/FAILED", 1800);

    // 4) 不再强制打开 findbar（这是导致 UI 抢焦点/体验突兀的来源之一）
    // const opened = this.dispatchEventBus(app, w, "findbaropen", {});
    // this.popup("dispatch findbaropen", opened ? "OK" : "FAILED", 1800);

    // 5) 触发 find（highlightAll = true）
    //    关键改动：caseSensitive=true，避免 Φ 与 φ、A 与 a 等混淆
    const dispatched = this.dispatchEventBus(app, w, "find", {
      query: selected,
      caseSensitive: this.CASE_SENSITIVE,
      highlightAll: true,
      phraseSearch: true,
      findPrevious: undefined,
    });
    this.popup(
      "dispatch find",
      dispatched
        ? `OK highlightAll=true caseSensitive=${this.CASE_SENSITIVE}`
        : "FAILED",
      dispatched ? 2000 : 4500,
    );

    // 5.5) 恢复滚动位置：抵消 PDF.js find 的自动定位滚动
    if (this.PREVENT_SCROLL && snap) {
      await this.delay(this.RESTORE_SCROLL_DELAY_MS);
      const restored = this.restoreScroll(app, snap);
      this.popup("restoreScroll()", restored ? "OK" : "FAILED", 1800);
    }

    // 6) 读回 findController 状态（用于确认 controller 是否收到 query）
    await this.delay(80);
    const state = this.peekFindState(app);
    this.popup("peek find state", state, 2600);
  }

  /**
   * 从 reader iframe 中获取 PDFViewerApplication（PDF.js viewer）
   */
  private static getPdfJsApp(reader: Reader): {
    app: any | null;
    w: any | null;
  } {
    try {
      const iframeWin = reader?._iframeWindow;
      if (!iframeWin) return { app: null, w: null };

      // wrappedJSObject 进入内容 realm
      const w = iframeWin.wrappedJSObject ?? iframeWin;

      // 常见挂载点
      const app = w?.PDFViewerApplication ?? null;

      return { app, w };
    } catch (e) {
      this.log(`getPdfJsApp failed: ${String(e)}`);
      return { app: null, w: null };
    }
  }

  /**
   * 捕获当前滚动位置（以及页码作为辅助）
   */
  private static captureScroll(app: any): ScrollSnapshot | null {
    try {
      const container =
        app?.pdfViewer?.container ??
        app?.appConfig?.mainContainer ??
        app?.appConfig?.viewerContainer ??
        null;

      if (!container) return null;

      const pageNumber =
        typeof app?.pdfViewer?.currentPageNumber === "number"
          ? app.pdfViewer.currentPageNumber
          : undefined;

      return {
        scrollTop: Number(container.scrollTop) || 0,
        scrollLeft: Number(container.scrollLeft) || 0,
        pageNumber,
      };
    } catch (e) {
      this.log(`captureScroll failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 恢复滚动位置（尽量不改变页码/视图）
   */
  private static restoreScroll(app: any, snap: ScrollSnapshot): boolean {
    try {
      const container =
        app?.pdfViewer?.container ??
        app?.appConfig?.mainContainer ??
        app?.appConfig?.viewerContainer ??
        null;

      if (!container) return false;

      // 优先直接恢复 scrollTop/scrollLeft
      container.scrollTop = snap.scrollTop;
      container.scrollLeft = snap.scrollLeft;

      // 页码恢复只作为“兜底”，避免在某些布局下仅设 scrollTop 不够
      if (
        typeof snap.pageNumber === "number" &&
        typeof app?.pdfViewer?.currentPageNumber === "number"
      ) {
        // 仅当 find 把页码改动很明显时才回写（避免额外抖动）
        // 这里不强制判断阈值；若你观察到抖动，可加条件。
        app.pdfViewer.currentPageNumber = snap.pageNumber;
      }

      return true;
    } catch (e) {
      this.log(`restoreScroll failed: ${String(e)}`);
      return false;
    }
  }

  /**
   * 通过 eventBus.dispatch 派发 PDF.js 事件
   * 关键：payload 必须在内容 realm 内构造，否则可能跨域对象导致静默失败
   */
  private static dispatchEventBus(
    app: any,
    w: any,
    name: string,
    payload: any,
  ): boolean {
    try {
      const eb = app?.eventBus;
      if (!eb || typeof eb.dispatch !== "function") return false;

      // 在内容 realm 内创建 payload 对象
      const contentPayload = w.JSON.parse(JSON.stringify(payload ?? {}));
      eb.dispatch(name, contentPayload);
      return true;
    } catch (e) {
      this.popup(`eventBus.dispatch EXCEPTION (${name})`, String(e), 4500);
      this.log(`dispatchEventBus failed: ${name} ${String(e)}`);
      return false;
    }
  }

  /**
   * 清理 PDF.js 查找高亮
   */
  private static clearPdfJsFind(app: any, w: any): boolean {
    try {
      // 优先 reset（若存在）
      if (
        app.findController &&
        typeof app.findController.reset === "function"
      ) {
        app.findController.reset();
        return true;
      }
      // 兜底：发送空 query 通常也会清理高亮
      return this.dispatchEventBus(app, w, "find", {
        query: "",
        highlightAll: false,
        phraseSearch: true,
        caseSensitive: true, // 清理时无所谓，但设成 true 不会引入额外合并
        findPrevious: undefined,
      });
    } catch (e) {
      this.log(`clearPdfJsFind failed: ${String(e)}`);
      return false;
    }
  }

  /**
   * 尝试读取 findController 内部状态，用于判断是否接收到 query
   * 注意：内部字段可能变化，因此只做“安全探测”
   */
  private static peekFindState(app: any): string {
    try {
      const fc = app?.findController;
      if (!fc) return "(findController missing)";

      const q = fc?.state?.query ?? fc?._state?.query ?? fc?._query ?? "";

      const m =
        fc?.state?.matchesCount?.total ?? fc?._state?.matchesCount?.total ?? "";

      return `query="${String(q)}" matchesTotal=${String(m)}`;
    } catch (e) {
      return `(peek error: ${String(e)})`;
    }
  }
}
