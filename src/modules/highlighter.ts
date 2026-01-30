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
  private static readonly TAG = "ZVH-highlighter-2026-01-29-r6";

  // Debug
  private static readonly DEBUG_POPUP = true;
  private static readonly VERBOSE_ON_EARLY_RETURN = true;

  // 调试期建议 0；稳定后可改成 150~300
  private static readonly POPUP_THROTTLE_MS = 0;

  // 行为参数
  private static readonly CASE_SENSITIVE = true; // 你前面已验证需要严格区分
  private static readonly PREVENT_SCROLL = true; // 彻底阻止自动滚动
  private static readonly SCROLL_LOCK_MS = 1200;  // 锁滚动窗口（ms）
  private static readonly AFTER_FIND_FORCE_FIRST_DELAY_MS = 200; // 等匹配完成后再强制首匹配（ms）

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

    this.log(`${headline} ${desc}`);

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

    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      this.handler,
      this.pluginID,
    );
    this.popup("registerEventListener OK", "renderTextSelectionPopup");
  }

  public static deactivate() {
    this.popup("deactivate()", `tag=${this.TAG}`);
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this.handler);
    this.popup("unregisterEventListener OK");
  }

  private static async onRenderTextSelectionPopup(evt: RenderTextSelectionPopupEvent) {
    this.popup("renderTextSelectionPopup FIRED", `tag=${this.TAG}`);

    const reader = evt?.reader;
    if (!reader) {
      if (this.VERBOSE_ON_EARLY_RETURN) this.popup("return", "evt.reader is null");
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
      try {
        const w0 = reader?._iframeWindow || reader?.contentWindow || null;
        const sel = w0?.getSelection?.();
        selected = String(sel?.toString?.() || "").trim();
      } catch {}
      this.popup("fallback selection", selected ? `\`${selected}\`` : "(empty)");
    }

    if (!selected) {
      if (this.VERBOSE_ON_EARLY_RETURN) this.popup("return", "selectedText empty", 2200);
      return;
    }

    selected = selected.replace(/\s+/g, " ").trim();
    this.popup("selectedText", `\`${selected}\` len=${selected.length}`);

    if (selected.length > 100) {
      if (this.VERBOSE_ON_EARLY_RETURN) this.popup("return", "selection too long (>100)", 2200);
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
        this.popup("return", "PDFViewerApplication not found (not a PDF.js viewer?)", 3000);
      }
      return;
    }

    // 3) 捕获视图 + 锁滚动（解决“自动滑动”）
    const snap = this.captureScroll(app);
    this.popup(
      "captureScroll()",
      snap ? `top=${snap.scrollTop} left=${snap.scrollLeft} page=${snap.pageNumber ?? "?"}` : "FAILED",
      1800,
    );

    let unlock: (() => void) | null = null;
    if (this.PREVENT_SCROLL && snap) {
      unlock = this.lockScroll(app, snap, this.SCROLL_LOCK_MS);
      this.popup("lockScroll()", unlock ? `OK ${this.SCROLL_LOCK_MS}ms` : "FAILED", 1800);
    }

    // 4) 清理旧高亮
    const cleared = this.clearPdfJsFind(app, w);
    this.popup("clearPdfJsFind()", cleared ? "OK" : "SKIP/FAILED", 1800);

    // 5) 触发 find：不打开 findbar，减少 UI 干扰；caseSensitive=true 解决 Φ/φ 混淆
    const dispatched = this.dispatchEventBus(app, w, "find", {
      query: selected,
      caseSensitive: this.CASE_SENSITIVE,
      highlightAll: true,
      phraseSearch: true,
      findPrevious: undefined,
    });
    this.popup(
      "dispatch find",
      dispatched ? `OK highlightAll=true caseSensitive=${this.CASE_SENSITIVE}` : "FAILED",
      dispatched ? 2000 : 4500,
    );

    // 6) 强制“全文第一次出现”为 current match（绿色）
    //    注意：这一步依赖 PDF.js 内部状态，属于 best-effort
    await this.delay(this.AFTER_FIND_FORCE_FIRST_DELAY_MS);
    const forced = this.forceGlobalFirstAsCurrentMatch(app);
    this.popup("forceGlobalFirstAsCurrentMatch()", forced ? "OK (best-effort)" : "SKIP/FAILED", 2200);

    // 7) 解除滚动锁（若设置了）
    if (unlock) {
      // 锁函数内部会自动定时解锁；这里额外提示即可
      this.popup("scroll lock", "will auto-release", 1200);
    }

    // 8) 回读状态（用于确认 controller 接收 query）
    await this.delay(120);
    const state = this.peekFindState(app);
    this.popup("peek find state", state, 2600);
  }

  private static getPdfJsApp(reader: Reader): { app: any | null; w: any | null } {
    try {
      const iframeWin = reader?._iframeWindow;
      if (!iframeWin) return { app: null, w: null };
      const w = iframeWin.wrappedJSObject ?? iframeWin;
      const app = w?.PDFViewerApplication ?? null;
      return { app, w };
    } catch (e) {
      this.log(`getPdfJsApp failed: ${String(e)}`);
      return { app: null, w: null };
    }
  }

  private static dispatchEventBus(app: any, w: any, name: string, payload: any): boolean {
    try {
      const eb = app?.eventBus;
      if (!eb || typeof eb.dispatch !== "function") return false;
      const contentPayload = w.JSON.parse(JSON.stringify(payload ?? {}));
      eb.dispatch(name, contentPayload);
      return true;
    } catch (e) {
      this.popup(`eventBus.dispatch EXCEPTION (${name})`, String(e), 4500);
      this.log(`dispatchEventBus failed: ${name} ${String(e)}`);
      return false;
    }
  }

  private static clearPdfJsFind(app: any, w: any): boolean {
    try {
      if (app.findController && typeof app.findController.reset === "function") {
        app.findController.reset();
        return true;
      }
      return this.dispatchEventBus(app, w, "find", {
        query: "",
        highlightAll: false,
        phraseSearch: true,
        caseSensitive: true,
        findPrevious: undefined,
      });
    } catch (e) {
      this.log(`clearPdfJsFind failed: ${String(e)}`);
      return false;
    }
  }

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
   * 短时间锁住滚动，阻止 PDF.js 在 find 后把 current match 滚动入视野。
   * PDF.js 的滚动通常来自 findController 的 scrollMatchIntoView / viewer 的 scrollPageIntoView 等路径。:contentReference[oaicite:1]{index=1}
   */
  private static lockScroll(app: any, snap: ScrollSnapshot, durationMs: number): (() => void) | null {
    try {
      const container =
        app?.pdfViewer?.container ??
        app?.appConfig?.mainContainer ??
        app?.appConfig?.viewerContainer ??
        null;
      if (!container) return null;

      const fc = app?.findController ?? null;

      // 1) patch 掉可能触发滚动的方法（若存在）
      const origScrollMatch = fc?.scrollMatchIntoView;
      const origScrollPageIntoView = app?.pdfViewer?.scrollPageIntoView;

      if (fc && typeof fc.scrollMatchIntoView === "function") {
        fc.scrollMatchIntoView = function () { /* no-op */ };
      }
      if (app?.pdfViewer && typeof app.pdfViewer.scrollPageIntoView === "function") {
        app.pdfViewer.scrollPageIntoView = function () { /* no-op */ };
      }

      // 2) 监听 scroll 并回滚（双保险）
      let active = true;
      const onScroll = () => {
        if (!active) return;
        if (container.scrollTop !== snap.scrollTop) container.scrollTop = snap.scrollTop;
        if (container.scrollLeft !== snap.scrollLeft) container.scrollLeft = snap.scrollLeft;
      };
      container.addEventListener("scroll", onScroll, { passive: true });

      // 3) 定时解锁并恢复方法
      const unlock = () => {
        if (!active) return;
        active = false;
        try { container.removeEventListener("scroll", onScroll); } catch {}

        try {
          if (fc && origScrollMatch && typeof origScrollMatch === "function") {
            fc.scrollMatchIntoView = origScrollMatch;
          }
        } catch {}

        try {
          if (app?.pdfViewer && origScrollPageIntoView && typeof origScrollPageIntoView === "function") {
            app.pdfViewer.scrollPageIntoView = origScrollPageIntoView;
          }
        } catch {}
      };

      // 立即回到 snap（防止刚 dispatch 后已经动了）
      onScroll();
      setTimeout(unlock, durationMs);

      return unlock;
    } catch (e) {
      this.log(`lockScroll failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 让“全文第一次出现”成为 current match（从而变绿）。
   * 该实现依赖 PDF.js 内部字段，属于 best-effort；字段名随版本可能变化。
   */
  private static forceGlobalFirstAsCurrentMatch(app: any): boolean {
    try {
      const fc = app?.findController;
      if (!fc) return false;

      // 判定是否已经有匹配结果：pageMatches / _pageMatches 等结构通常存在
      const pageMatches = fc.pageMatches ?? fc._pageMatches ?? null;
      if (!pageMatches || !Array.isArray(pageMatches)) {
        // 仍可能成功，但缺少结果结构时不强行写，避免破坏状态机
        return false;
      }

      // 找到全局第一个匹配：从 pageIdx=0 向后找第一个非空数组
      let firstPageIdx = -1;
      for (let i = 0; i < pageMatches.length; i++) {
        const arr = pageMatches[i];
        if (Array.isArray(arr) && arr.length > 0) {
          firstPageIdx = i;
          break;
        }
      }
      if (firstPageIdx < 0) return false;

      const first = { pageIdx: firstPageIdx, matchIdx: 0 };

      // 常见内部状态：_selected / _offset / state
      if (fc._selected && typeof fc._selected === "object") {
        fc._selected.pageIdx = first.pageIdx;
        fc._selected.matchIdx = first.matchIdx;
      } else {
        fc._selected = { pageIdx: first.pageIdx, matchIdx: first.matchIdx };
      }

      if (fc._offset && typeof fc._offset === "object") {
        fc._offset.pageIdx = first.pageIdx;
        fc._offset.matchIdx = first.matchIdx;
      }

      // 尝试触发 UI 更新（函数名随版本变化）
      if (typeof fc._updateMatch === "function") {
        fc._updateMatch(true);
      } else if (typeof fc._updateUIState === "function") {
        fc._updateUIState();
      }

      return true;
    } catch (e) {
      this.log(`forceGlobalFirstAsCurrentMatch failed: ${String(e)}`);
      return false;
    }
  }

  private static peekFindState(app: any): string {
    try {
      const fc = app?.findController;
      if (!fc) return "(findController missing)";

      const q = fc?.state?.query ?? fc?._state?.query ?? fc?._query ?? "";
      const m = fc?.state?.matchesCount?.total ?? fc?._state?.matchesCount?.total ?? "";

      return `query="${String(q)}" matchesTotal=${String(m)}`;
    } catch (e) {
      return `(peek error: ${String(e)})`;
    }
  }
}
