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

type GlobalFirstMatch = {
  pageIdx: number;
  matchIdx: number;
  pageNumber: number; // 1-based page number for display
};

export class Highlighter {
  // 版本指纹：用来确认你运行的就是这份文件
  private static readonly TAG = "ZVH-highlighter-2026-02-25-r1";

  // Debug
  private static readonly DEBUG_POPUP = false;
  private static readonly VERBOSE_ON_EARLY_RETURN = true;

  // 调试期建议 0；稳定后可改成 150~300
  private static readonly POPUP_THROTTLE_MS = 0;

  // 行为参数
  private static readonly CASE_SENSITIVE = true; // 你前面已验证需要严格区分
  private static readonly PREVENT_SCROLL = true; // 彻底阻止自动滚动
  private static readonly SCROLL_LOCK_MS = 1200; // 锁滚动窗口（ms）
  private static readonly AFTER_FIND_FORCE_FIRST_DELAY_MS = 200; // 等匹配完成后再强制首匹配（ms）
  private static readonly WAIT_FOR_FULL_SEARCH_MS = 2000; // 等待全文搜索完成的最大时间
  private static readonly POLL_INTERVAL_MS = 50; // 轮询间隔
  private static readonly DOM_RENDER_DELAY_MS = 100; // 等待 PDF.js DOM 渲染完成的延迟
  private static readonly PAGE_RENDER_COMPLETION_DELAY_MS = 50; // 页面渲染完成后标记全文第一个匹配的延迟

  // 默认高亮颜色
  private static readonly DEFAULT_FIRST_MATCH_COLOR = "#00FF00"; // 绿色 - 全文第一个匹配
  private static readonly DEFAULT_OTHER_MATCH_COLOR = "#FF69B4"; // 粉色 - 其他匹配

  private static debugSeq = 0;
  private static lastPopupAt = 0;

  private static addon: any;
  private static pluginID = "zotero-var-highlighter@local";

  // 存储当前全文第一个匹配的信息
  private static currentGlobalFirstMatch: GlobalFirstMatch | null = null;
  private static currentSelectedText: string = "";

  // 预览窗口相关
  private static previewPopup: HTMLElement | null = null;
  private static currentApp: any = null;

  // MutationObserver 用于监听页面渲染，重新标记全文第一个匹配
  private static pageRenderObserver: MutationObserver | null = null;
  private static currentPdfWindow: any = null;

  // Localization strings
  private static readonly STRINGS = {
    en: {
      firstOccurrence: "First occurrence: Page",
      variable: "Variable:",
      clickToJump: "Click to jump to page",
      clickHint: "Click to jump to this page",
    },
    zh: {
      firstOccurrence: "首次出现：第",
      firstOccurrenceSuffix: "页",
      variable: "变量:",
      clickToJump: "点击跳转到第",
      clickToJumpSuffix: "页",
      clickHint: "点击跳转到此页面",
    },
  };

  // 稳定引用，便于 unregister
  private static readonly handler = (evt: RenderTextSelectionPopupEvent) => {
    void Highlighter.onRenderTextSelectionPopup(evt);
  };

  /**
   * Get current locale strings
   */
  private static getStrings(): typeof Highlighter.STRINGS.en {
    try {
      const locale = Zotero.locale || "en-US";
      if (locale.startsWith("zh")) {
        return this.STRINGS.zh as typeof Highlighter.STRINGS.en;
      }
    } catch {}
    return this.STRINGS.en;
  }

  /**
   * Get localized text for "First occurrence: Page X"
   */
  private static getFirstOccurrenceText(pageNumber: number): string {
    try {
      const locale = Zotero.locale || "en-US";
      if (locale.startsWith("zh")) {
        return `${this.STRINGS.zh.firstOccurrence} ${pageNumber} ${this.STRINGS.zh.firstOccurrenceSuffix}`;
      }
    } catch {}
    return `${this.STRINGS.en.firstOccurrence} ${pageNumber}`;
  }

  /**
   * Get localized text for "Click to jump to page X"
   */
  private static getClickToJumpText(pageNumber: number): string {
    try {
      const locale = Zotero.locale || "en-US";
      if (locale.startsWith("zh")) {
        return `${this.STRINGS.zh.clickToJump} ${pageNumber} ${this.STRINGS.zh.clickToJumpSuffix}`;
      }
    } catch {}
    return `${this.STRINGS.en.clickToJump} ${pageNumber}`;
  }

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

  /**
   * 获取第一个匹配的高亮颜色（用户可自定义）
   */
  public static getFirstMatchColor(): string {
    try {
      const color = Zotero.Prefs.get(
        "extensions.zotero.zotero-var-highlighter.firstMatchColor",
      );
      return typeof color === "string" && color
        ? color
        : this.DEFAULT_FIRST_MATCH_COLOR;
    } catch {
      return this.DEFAULT_FIRST_MATCH_COLOR;
    }
  }

  /**
   * 获取其他匹配的高亮颜色（用户可自定义）
   */
  public static getOtherMatchColor(): string {
    try {
      const color = Zotero.Prefs.get(
        "extensions.zotero.zotero-var-highlighter.otherMatchColor",
      );
      return typeof color === "string" && color
        ? color
        : this.DEFAULT_OTHER_MATCH_COLOR;
    } catch {
      return this.DEFAULT_OTHER_MATCH_COLOR;
    }
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

    // 清理 MutationObserver
    if (this.pageRenderObserver) {
      this.pageRenderObserver.disconnect();
      this.pageRenderObserver = null;
    }

    Zotero.Reader.unregisterEventListener(
      "renderTextSelectionPopup",
      this.handler,
    );
    this.popup("unregisterEventListener OK");
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

    // 保存 app 引用用于预览功能
    this.currentApp = app;

    // 3) 捕获视图 + 锁滚动（解决"自动滑动"）
    const snap = this.captureScroll(app);
    this.popup(
      "captureScroll()",
      snap
        ? `top=${snap.scrollTop} left=${snap.scrollLeft} page=${snap.pageNumber ?? "?"}`
        : "FAILED",
      1800,
    );

    let unlock: (() => void) | null = null;
    if (this.PREVENT_SCROLL && snap) {
      unlock = this.lockScroll(app, snap, this.SCROLL_LOCK_MS);
      this.popup(
        "lockScroll()",
        unlock ? `OK ${this.SCROLL_LOCK_MS}ms` : "FAILED",
        1800,
      );
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
      dispatched
        ? `OK highlightAll=true caseSensitive=${this.CASE_SENSITIVE}`
        : "FAILED",
      dispatched ? 2000 : 4500,
    );

    // 保存当前选中的文本，用于预览功能
    this.currentSelectedText = selected;

    // 6) 强制"全文第一次出现"为 current match（绿色）
    //    等待全文搜索完成，确保找到的是真正的全文第一个匹配
    const forced = await this.forceGlobalFirstAsCurrentMatchAsync(app);
    this.popup(
      "forceGlobalFirstAsCurrentMatch()",
      forced ? "OK (best-effort)" : "SKIP/FAILED",
      2200,
    );

    // 7) 应用自定义颜色
    this.applyCustomHighlightColors(app, w);

    // 8) 在 DOM 中标记全文第一个匹配
    //    等待一小段时间让 PDF.js 完成 DOM 渲染
    await this.delay(this.DOM_RENDER_DELAY_MS);
    this.markGlobalFirstMatchInDOM(app, w);

    // 9) 设置页面渲染监听器，以便在目标页面被懒加载渲染时重新标记
    this.setupPageRenderObserver(app, w);

    // 10) 解除滚动锁（若设置了）
    if (unlock) {
      // 锁函数内部会自动定时解锁；这里额外提示即可
      this.popup("scroll lock", "will auto-release", 1200);
    }

    // 11) 回读状态（用于确认 controller 接收 query）
    await this.delay(120);
    const state = this.peekFindState(app);
    this.popup("peek find state", state, 2600);

    // 12) 设置预览窗口的悬停事件
    this.setupPreviewHover(app, w, reader);
  }

  private static getPdfJsApp(reader: Reader): {
    app: any | null;
    w: any | null;
  } {
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

  private static dispatchEventBus(
    app: any,
    w: any,
    name: string,
    payload: any,
  ): boolean {
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
      if (
        app.findController &&
        typeof app.findController.reset === "function"
      ) {
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
   * PDF.js 的滚动通常来自 findController 的 scrollMatchIntoView / viewer 的 scrollPageIntoView 等路径。
   */
  private static lockScroll(
    app: any,
    snap: ScrollSnapshot,
    durationMs: number,
  ): (() => void) | null {
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
        fc.scrollMatchIntoView = function () {
          /* no-op */
        };
      }
      if (
        app?.pdfViewer &&
        typeof app.pdfViewer.scrollPageIntoView === "function"
      ) {
        app.pdfViewer.scrollPageIntoView = function () {
          /* no-op */
        };
      }

      // 2) 监听 scroll 并回滚（双保险）
      let active = true;
      const onScroll = () => {
        if (!active) return;
        if (container.scrollTop !== snap.scrollTop)
          container.scrollTop = snap.scrollTop;
        if (container.scrollLeft !== snap.scrollLeft)
          container.scrollLeft = snap.scrollLeft;
      };
      container.addEventListener("scroll", onScroll, { passive: true });

      // 3) 定时解锁并恢复方法
      const unlock = () => {
        if (!active) return;
        active = false;
        try {
          container.removeEventListener("scroll", onScroll);
        } catch {}

        try {
          if (fc && origScrollMatch && typeof origScrollMatch === "function") {
            fc.scrollMatchIntoView = origScrollMatch;
          }
        } catch {}

        try {
          if (
            app?.pdfViewer &&
            origScrollPageIntoView &&
            typeof origScrollPageIntoView === "function"
          ) {
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
   * 等待全文搜索完成，然后让"全文第一次出现"成为 current match（从而变绿）。
   * 该实现等待 PDF.js 完成所有页面的搜索，确保找到的是真正的全文第一个匹配。
   */
  private static async forceGlobalFirstAsCurrentMatchAsync(
    app: any,
  ): Promise<boolean> {
    try {
      const fc = app?.findController;
      if (!fc) return false;

      const totalPages = app?.pdfViewer?.pagesCount ?? app?.pagesCount ?? 0;
      if (totalPages === 0) return false;

      // 等待搜索完成 - 轮询检查 pendingFindMatches 或等待所有页面的 pageMatches 被填充
      const startTime = Date.now();
      let allPagesSearched = false;

      while (Date.now() - startTime < this.WAIT_FOR_FULL_SEARCH_MS) {
        // 检查是否有挂起的搜索
        const pendingMatches = fc._pendingFindMatches ?? fc.pendingFindMatches;
        // Only break when we know search is complete (pendingMatches === 0)
        // If property doesn't exist, continue checking pageMatches
        const searchComplete =
          pendingMatches === 0 ||
          (pendingMatches === undefined &&
            fc.pageMatches !== undefined &&
            fc._pageMatches !== undefined);

        if (searchComplete) {
          // 检查 pageMatches 数组的长度是否等于总页数
          const pageMatches = fc.pageMatches ?? fc._pageMatches ?? [];
          if (Array.isArray(pageMatches) && pageMatches.length === totalPages) {
            allPagesSearched = true;
            break;
          }
        }
        await this.delay(this.POLL_INTERVAL_MS);
      }

      this.popup(
        "waitForSearch",
        `allPagesSearched=${allPagesSearched} totalPages=${totalPages}`,
        1800,
      );

      // 现在查找全文第一个匹配
      const pageMatches = fc.pageMatches ?? fc._pageMatches ?? null;
      if (!pageMatches || !Array.isArray(pageMatches)) {
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

      // 保存全文第一个匹配的信息
      this.currentGlobalFirstMatch = {
        pageIdx: firstPageIdx,
        matchIdx: 0,
        pageNumber: firstPageIdx + 1, // 1-based
      };

      this.popup(
        "globalFirstMatch",
        `pageIdx=${firstPageIdx} pageNumber=${firstPageIdx + 1}`,
        2000,
      );

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
      this.log(`forceGlobalFirstAsCurrentMatchAsync failed: ${String(e)}`);
      return false;
    }
  }

  /**
   * 应用自定义的高亮颜色
   * 使用 CSS 覆盖 PDF.js 默认的高亮颜色
   * 使用自定义 data 属性来标识全文第一个匹配，避免依赖 PDF.js 的 selected 类
   */
  private static applyCustomHighlightColors(app: any, w: any): void {
    try {
      const doc = w?.document;
      if (!doc) return;

      const firstColor = this.getFirstMatchColor();
      const otherColor = this.getOtherMatchColor();

      // 移除旧的样式
      const existingStyle = doc.getElementById("zvh-highlight-colors");
      if (existingStyle) {
        existingStyle.remove();
      }

      // 创建新的样式
      // 注意：不再依赖 .selected 类，而是使用我们自己的 data-zvh-first-match 属性
      const style = doc.createElement("style");
      style.id = "zvh-highlight-colors";
      style.textContent = `
        /* 所有匹配的默认高亮颜色（粉色）*/
        .textLayer .highlight {
          background-color: ${otherColor} !important;
          opacity: 0.4 !important;
        }
        /* 覆盖 PDF.js 的 .selected 样式，使其与普通高亮一样（粉色）*/
        .textLayer .highlight.selected {
          background-color: ${otherColor} !important;
          opacity: 0.4 !important;
        }
        /* 全文第一个匹配使用特殊颜色（绿色）- 使用我们自己的 data 属性 */
        .textLayer .highlight[data-zvh-first-match="true"] {
          background-color: ${firstColor} !important;
          opacity: 0.5 !important;
        }
      `;

      doc.head.appendChild(style);
      this.popup(
        "applyColors",
        `first=${firstColor} other=${otherColor}`,
        1600,
      );
    } catch (e) {
      this.log(`applyCustomHighlightColors failed: ${String(e)}`);
    }
  }

  /**
   * 在 DOM 中标记全文第一个匹配
   * 使用自定义 data 属性而不是依赖 PDF.js 的 selected 类
   */
  private static markGlobalFirstMatchInDOM(app: any, w: any): void {
    try {
      const doc = w?.document;
      if (!doc || !this.currentGlobalFirstMatch) return;

      const { pageIdx, matchIdx } = this.currentGlobalFirstMatch;

      // 先移除所有旧的标记
      const oldMarks = doc.querySelectorAll("[data-zvh-first-match]");
      oldMarks.forEach((el: Element) => {
        el.removeAttribute("data-zvh-first-match");
      });

      // 找到对应页面的 textLayer
      const pageContainer = doc.querySelector(
        `[data-page-number="${pageIdx + 1}"]`,
      );
      if (!pageContainer) {
        this.popup(
          "markGlobalFirstMatch",
          `page container not found for page ${pageIdx + 1}`,
          2000,
        );
        return;
      }

      const textLayer = pageContainer.querySelector(".textLayer");
      if (!textLayer) {
        this.popup("markGlobalFirstMatch", "textLayer not found", 2000);
        return;
      }

      // 找到该页面中的所有高亮元素
      const highlights = textLayer.querySelectorAll(".highlight");
      if (highlights.length === 0) {
        this.popup("markGlobalFirstMatch", "no highlights found", 2000);
        return;
      }

      // 标记第 matchIdx 个高亮元素为全文第一个匹配
      if (matchIdx < highlights.length) {
        highlights[matchIdx].setAttribute("data-zvh-first-match", "true");
        this.popup(
          "markGlobalFirstMatch",
          `marked highlight ${matchIdx} on page ${pageIdx + 1}`,
          1600,
        );
      } else {
        this.popup(
          "markGlobalFirstMatch",
          `matchIdx ${matchIdx} >= highlights.length ${highlights.length}`,
          2000,
        );
      }
    } catch (e) {
      this.log(`markGlobalFirstMatchInDOM failed: ${String(e)}`);
    }
  }

  /**
   * 设置 MutationObserver 来监听页面渲染事件
   * 当全文第一个匹配所在的页面被渲染时，重新标记该高亮元素
   */
  private static setupPageRenderObserver(app: any, w: any): void {
    try {
      // 清理旧的 observer
      if (this.pageRenderObserver) {
        this.pageRenderObserver.disconnect();
        this.pageRenderObserver = null;
      }

      const doc = w?.document;
      if (!doc || !this.currentGlobalFirstMatch) return;

      this.currentPdfWindow = w;

      const viewerContainer = doc.querySelector("#viewer, .pdfViewer");
      if (!viewerContainer) return;

      // 创建新的 MutationObserver
      this.pageRenderObserver = new MutationObserver((mutations) => {
        // 检查是否有新的高亮元素被添加到目标页面
        if (!this.currentGlobalFirstMatch) return;

        const { pageIdx } = this.currentGlobalFirstMatch;
        const targetPageNumber = pageIdx + 1;

        for (const mutation of mutations) {
          if (mutation.type === "childList") {
            // 检查是否是目标页面的变化
            const target = mutation.target as Element;
            const pageContainer =
              target.closest(`[data-page-number="${targetPageNumber}"]`) ||
              target.querySelector(`[data-page-number="${targetPageNumber}"]`);

            if (pageContainer) {
              // 延迟执行标记，等待 PDF.js 完成渲染
              setTimeout(() => {
                this.markGlobalFirstMatchInDOM(app, this.currentPdfWindow);
              }, this.PAGE_RENDER_COMPLETION_DELAY_MS);
              break;
            }
          }
        }
      });

      // 开始观察
      this.pageRenderObserver.observe(viewerContainer, {
        childList: true,
        subtree: true,
      });
    } catch (e) {
      this.log(`setupPageRenderObserver failed: ${String(e)}`);
    }
  }

  /**
   * 设置预览窗口的悬停事件
   * 当用户将鼠标放在高亮的文本上时，显示全文第一次出现的预览
   */
  private static setupPreviewHover(app: any, w: any, reader: Reader): void {
    try {
      const doc = w?.document;
      if (!doc) return;

      // 移除旧的事件监听器（通过重新设置来实现）
      const textLayer = doc.querySelector(".textLayer");
      if (!textLayer) return;

      // 使用事件委托监听高亮元素的悬停
      const handleMouseEnter = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (
          target.classList.contains("highlight") &&
          this.currentGlobalFirstMatch
        ) {
          this.showPreviewPopup(app, w, reader, e);
        }
      };

      const handleMouseLeave = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("highlight")) {
          this.hidePreviewPopup(w);
        }
      };

      // 移除旧的监听器标记
      const oldEnterHandler = (textLayer as any).__zvhMouseEnter;
      const oldLeaveHandler = (textLayer as any).__zvhMouseLeave;
      if (oldEnterHandler) {
        textLayer.removeEventListener("mouseenter", oldEnterHandler, true);
      }
      if (oldLeaveHandler) {
        textLayer.removeEventListener("mouseleave", oldLeaveHandler, true);
      }

      // 添加新的监听器
      textLayer.addEventListener("mouseenter", handleMouseEnter, true);
      textLayer.addEventListener("mouseleave", handleMouseLeave, true);

      // 保存引用以便后续移除
      (textLayer as any).__zvhMouseEnter = handleMouseEnter;
      (textLayer as any).__zvhMouseLeave = handleMouseLeave;
    } catch (e) {
      this.log(`setupPreviewHover failed: ${String(e)}`);
    }
  }

  /**
   * 显示预览弹窗，展示全文第一次出现的位置
   */
  private static async showPreviewPopup(
    app: any,
    w: any,
    reader: Reader,
    event: MouseEvent,
  ): Promise<void> {
    try {
      if (!this.currentGlobalFirstMatch) return;

      const doc = w?.document;
      if (!doc) return;

      // 隐藏之前的弹窗
      this.hidePreviewPopup(w);

      const { pageNumber } = this.currentGlobalFirstMatch;

      // 创建预览弹窗
      const popup = doc.createElement("div");
      popup.id = "zvh-preview-popup";
      popup.style.cssText = `
        position: fixed;
        z-index: 10000;
        background: white;
        border: 2px solid #333;
        border-radius: 8px;
        padding: 10px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        max-width: 300px;
        max-height: 400px;
        overflow: hidden;
      `;

      // 计算弹窗位置
      const mouseX = event.clientX;
      const mouseY = event.clientY;
      const viewportWidth = w.innerWidth;
      const viewportHeight = w.innerHeight;

      // 默认在鼠标右下方显示
      let left = mouseX + 15;
      let top = mouseY + 15;

      // 防止超出视口
      if (left + 320 > viewportWidth) {
        left = mouseX - 320;
      }
      if (top + 420 > viewportHeight) {
        top = mouseY - 420;
      }

      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;

      // Get localized strings
      const strings = this.getStrings();

      // 添加标题
      const title = doc.createElement("div");
      title.style.cssText = `
        font-weight: bold;
        margin-bottom: 8px;
        padding-bottom: 8px;
        border-bottom: 1px solid #ddd;
        font-size: 14px;
        color: #333;
      `;
      title.textContent = this.getFirstOccurrenceText(pageNumber);
      popup.appendChild(title);

      // 添加文本内容
      const content = doc.createElement("div");
      content.style.cssText = `
        font-size: 12px;
        color: #666;
        margin-bottom: 8px;
      `;
      content.textContent = `${strings.variable} "${this.currentSelectedText}"`;
      popup.appendChild(content);

      // 尝试获取页面缩略图
      const thumbnail = await this.getPageThumbnail(app, w, pageNumber);
      if (thumbnail) {
        const imgContainer = doc.createElement("div");
        imgContainer.style.cssText = `
          width: 100%;
          max-height: 300px;
          overflow: hidden;
          display: flex;
          justify-content: center;
          align-items: center;
          background: #f5f5f5;
          border-radius: 4px;
        `;

        const img = doc.createElement("img");
        img.src = thumbnail;
        img.style.cssText = `
          max-width: 100%;
          max-height: 280px;
          object-fit: contain;
        `;
        img.alt = `Page ${pageNumber} preview`;

        imgContainer.appendChild(img);
        popup.appendChild(imgContainer);
      } else {
        // 如果无法获取缩略图，显示提示信息
        const placeholder = doc.createElement("div");
        placeholder.style.cssText = `
          width: 100%;
          height: 150px;
          display: flex;
          justify-content: center;
          align-items: center;
          background: #f5f5f5;
          border-radius: 4px;
          color: #999;
          font-size: 12px;
        `;
        placeholder.textContent = this.getClickToJumpText(pageNumber);
        popup.appendChild(placeholder);
      }

      // 添加点击跳转功能
      popup.style.cursor = "pointer";
      popup.addEventListener("click", () => {
        this.jumpToPage(app, pageNumber);
        this.hidePreviewPopup(w);
      });

      // 添加提示
      const hint = doc.createElement("div");
      hint.style.cssText = `
        font-size: 11px;
        color: #999;
        margin-top: 8px;
        text-align: center;
      `;
      hint.textContent = strings.clickHint;
      popup.appendChild(hint);

      doc.body.appendChild(popup);
      this.previewPopup = popup;
    } catch (e) {
      this.log(`showPreviewPopup failed: ${String(e)}`);
    }
  }

  /**
   * 隐藏预览弹窗
   */
  private static hidePreviewPopup(w: any): void {
    try {
      if (this.previewPopup) {
        this.previewPopup.remove();
        this.previewPopup = null;
      }
      // 也尝试从 document 中移除
      const doc = w?.document;
      if (doc) {
        const existing = doc.getElementById("zvh-preview-popup");
        if (existing) {
          existing.remove();
        }
      }
    } catch (e) {
      this.log(`hidePreviewPopup failed: ${String(e)}`);
    }
  }

  /**
   * 获取指定页面的缩略图
   */
  private static async getPageThumbnail(
    app: any,
    w: any,
    pageNumber: number,
  ): Promise<string | null> {
    try {
      const pdfDocument = app?.pdfDocument;
      if (!pdfDocument) return null;

      const doc = w?.document;
      if (!doc) return null;

      const page = await pdfDocument.getPage(pageNumber);
      if (!page) return null;

      // 获取页面尺寸，创建合适的缩略图
      const viewport = page.getViewport({ scale: 0.5 });
      const canvas = doc.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return null;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      // 渲染页面到 canvas
      await page.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;

      // 转换为 data URL
      return canvas.toDataURL("image/png");
    } catch (e) {
      this.log(`getPageThumbnail failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 跳转到指定页面
   */
  private static jumpToPage(app: any, pageNumber: number): void {
    try {
      if (app?.pdfViewer) {
        app.pdfViewer.currentPageNumber = pageNumber;
      }
    } catch (e) {
      this.log(`jumpToPage failed: ${String(e)}`);
    }
  }

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
