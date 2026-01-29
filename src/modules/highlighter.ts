type Reader = any;

type RenderTextSelectionPopupEvent = {
  reader?: Reader;
  doc?: Document;
  params?: any;
  append?: (node: Node) => void;
};

export class Highlighter {
  // 版本指纹：用来确认你运行的就是这份文件
  private static readonly TAG = "ZVH-highlighter-2026-01-29-r5";

  // Debug
  private static readonly DEBUG_POPUP = true;
  private static readonly VERBOSE_ON_EARLY_RETURN = true;

  // 关键：调试期必须关节流，否则只看到第一条
  private static readonly POPUP_THROTTLE_MS = 0;

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

    // 0) 把 tag 注入 popup UI，肉眼确认版本
    try {
      if (evt.doc && typeof evt.append === "function") {
        const el = evt.doc.createElement("div");
        el.textContent = `tag=${this.TAG}`;
        el.style.cssText =
          "margin-top:6px;padding:2px 6px;border-radius:6px;font-size:11px;opacity:.85;" +
          "background:rgba(0,0,0,.06);";
        evt.append(el);
      }
    } catch {}

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
        const w = reader?._iframeWindow || reader?.contentWindow || null;
        const sel = w?.getSelection?.();
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

    // 规范化空白
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

    // 3) 清理旧的 find 高亮（PDF.js 级别）
    const cleared = this.clearPdfJsFind(app, w);
    this.popup("clearPdfJsFind()", cleared ? "OK" : "SKIP/FAILED", 1800);

    // 4) 强制打开 findbar（用于肉眼确认“查找已被触发”）
    const opened = this.dispatchEventBus(app, w, "findbaropen", {});
    this.popup("dispatch findbaropen", opened ? "OK" : "FAILED", 1800);

    // 5) 触发 find（highlightAll = true）
    const dispatched = this.dispatchEventBus(app, w, "find", {
      query: selected,
      caseSensitive: false,
      highlightAll: true,
      phraseSearch: true,
      findPrevious: undefined,
    });
    this.popup(
      "dispatch find",
      dispatched ? "OK highlightAll=true" : "FAILED",
      dispatched ? 2000 : 4500,
    );

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
        caseSensitive: false,
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
