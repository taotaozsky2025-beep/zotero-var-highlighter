import { HoverPreview } from "./hover-preview";

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

type GlobalFirstMatchResult = {
  ready: boolean;
  pageIdx: number;
};

export class Highlighter {
  // 版本指纹：用来确认你运行的就是这份文件
  private static readonly TAG = "ZVH-highlighter-2026-05-07-r16";

  // Debug
  private static readonly DEBUG_POPUP = false;
  private static readonly VERBOSE_ON_EARLY_RETURN = true;
  // 诊断 first-match 选页逻辑：开启后，每次选中文本会在 dispatch find
  // 之后约 2.5 秒弹出一个 ProgressWindow，里面只显示我们最关心的几个数：
  // - currentPage：你选词时所在的页（1-based）
  // - chosenPageIdx：getGlobalFirstMatchPageIdx 实际返回的"全文第一个" pageIdx（0-based）
  // - markerPageIdx：marker 实际成功 add class 的 pageIdx（-1 表示未应用）
  // - per-page 简表：前 N 页的 pageMatches 长度 / pageContents 是否就绪
  // 拍下这个弹窗的截图发我，就能定位是匹配逻辑错还是 DOM 应用错。
  private static readonly DIAGNOSE_FIRST_MATCH = true;
  private static readonly DIAGNOSE_DELAY_MS = 2500;
  private static readonly DIAGNOSE_PAGES_TO_DUMP = 12;

  // 调试期建议 0；稳定后可改成 150~300
  private static readonly POPUP_THROTTLE_MS = 0;

  // 行为参数
  private static readonly CASE_SENSITIVE = true; // 你前面已验证需要严格区分
  private static readonly PREVENT_SCROLL = true; // 彻底阻止自动滚动
  // PDF.js 异步分页搜索可能耗时数秒，方法 patch 需覆盖整个搜索过程；
  // 这里不持续监听 scroll，只在触发 find 后做短窗口回位，避免拦截用户主动滚动。
  private static readonly SCROLL_LOCK_MS = 8000; // 滚动锁定/方法 patch 总时长（ms）
  private static readonly HARD_SCROLL_RESTORE_MS = 1400;
  private static readonly AFTER_FIND_FORCE_FIRST_DELAY_MS = 200; // 初次强制首匹配的延迟（ms）
  private static readonly ENTIRE_WORD_FOR_SINGLE_ASCII = false;
  // 不再写 PDF.js 的 _selected/_offset 或调用 _updateMatch(true)；
  // 这类私有调用在当前 Zotero/PDF.js 组合中会导致 reader 崩溃。
  // 这里用 DOM class 把全文第一处视觉上标成“当前匹配”。
  private static readonly MARK_GLOBAL_FIRST_MATCH = true;
  private static readonly ENABLE_HOVER_PREVIEW = true;
  private static readonly SELECTION_DEBOUNCE_MS = 500;
  private static readonly FIRST_MARK_CLASS = "zvh-global-first-match";
  private static readonly FIRST_MARK_STYLE_ATTR = "data-zvh-first-match-style";
  private static readonly SUPPRESS_SELECTED_STYLE_ATTR =
    "data-zvh-suppress-selected-style";
  // 持续强制监听器最大次数（约 240 * POLL_INTERVAL_MS = 30s）。
  // 之前还有 STABLE_THRESHOLD 控制"firstPageIdx 不变 N 次后 detach"，
  // 但是 PDF.js 会反复重建 textLayer 把 marker class 冲掉，
  // 不能基于 firstPageIdx 稳定就 detach；现在改为持续 polling 补贴 marker，
  // 直到 MAX_ATTEMPTS 达到上限或下一次 selection 触发 detach。
  private static readonly FORCE_FIRST_MAX_ATTEMPTS = 240;
  private static readonly FORCE_FIRST_TIMEOUT_MS = 30000;
  private static readonly FORCE_FIRST_POLL_INTERVAL_MS = 120;

  private static debugSeq = 0;
  private static lastPopupAt = 0;
  private static lastSelectionKey = "";
  private static lastSelectionAt = 0;

  private static addon: any;
  private static pluginID = "zotero-var-highlighter@local";
  private static forceFirstDetach: (() => void) | null = null;
  private static scrollUnlock: (() => void) | null = null;
  private static lastMarkerDoc: Document | null = null;
  // 诊断用：上一次 marker 实际成功打到的 pageIdx（-1 表示没打上）
  private static lastMarkerAppliedPageIdx: number = -1;

  // 稳定引用，便于 unregister
  private static readonly handler = (evt: RenderTextSelectionPopupEvent) => {
    void Highlighter.onRenderTextSelectionPopup(evt);
  };

  private static log(msg: string) {
    try {
      Zotero.debug(`[zotero-var-highlighter] ${msg}`);
    } catch {
      /* ignore */
    }
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
    } catch {
      /* ignore */
    }
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
    this.detachContinuousForceFirst();
    this.releaseScrollLock();
    this.clearFirstMatchMarker();
    Zotero.Reader.unregisterEventListener(
      "renderTextSelectionPopup",
      this.handler,
    );
    this.popup("unregisterEventListener OK");
    try {
      HoverPreview.deactivate();
    } catch (e) {
      this.log(`HoverPreview.deactivate failed: ${String(e)}`);
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

    if (this.ENABLE_HOVER_PREVIEW) {
      // 新一次选中：先把上一次的 hover popup/canvas 隐藏，避免残留指向旧 query
      try {
        HoverPreview.onFindCleared(reader);
      } catch (e) {
        this.log(`HoverPreview.onFindCleared failed: ${String(e)}`);
      }
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
    } catch {
      /* ignore */
    }

    this.popup("extract params text", selected ? `\`${selected}\`` : "(empty)");

    if (!selected) {
      try {
        const w0 = reader?._iframeWindow || reader?.contentWindow || null;
        const sel = w0?.getSelection?.();
        selected = String(sel?.toString?.() || "").trim();
      } catch {
        /* ignore */
      }
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

    const now = Date.now();
    const selectionKey = `${String(reader?.itemID ?? reader?.id ?? "")}:${selected}`;
    if (
      selectionKey === this.lastSelectionKey &&
      now - this.lastSelectionAt < this.SELECTION_DEBOUNCE_MS
    ) {
      this.popup("return", "duplicate selection event", 1200);
      return;
    }
    this.lastSelectionKey = selectionKey;
    this.lastSelectionAt = now;

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

    this.detachContinuousForceFirst();
    this.releaseScrollLock();
    this.clearFirstMatchMarker();
    this.lastMarkerAppliedPageIdx = -1;
    this.prepareReaderHighlightStyles(reader, app);

    // 3) 捕获视图 + 锁滚动（解决“自动滑动”）
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
      this.scrollUnlock = unlock;
      if (unlock) {
        setTimeout(() => {
          if (this.scrollUnlock === unlock) this.scrollUnlock = null;
        }, this.SCROLL_LOCK_MS + 50);
      }
      this.popup(
        "lockScroll()",
        unlock ? `OK ${this.SCROLL_LOCK_MS}ms` : "FAILED",
        1800,
      );
    }

    // 4) 清理旧高亮
    const cleared = this.clearPdfJsFind(app, w);
    this.popup("clearPdfJsFind()", cleared ? "OK" : "SKIP/FAILED", 1800);

    if (!this.MARK_GLOBAL_FIRST_MATCH) {
      const dispatchedSimple = this.dispatchEventBus(app, w, "find", {
        query: selected,
        caseSensitive: this.CASE_SENSITIVE,
        entireWord: this.shouldSearchEntireWord(selected),
        highlightAll: true,
        phraseSearch: true,
        findPrevious: undefined,
      });
      if (!dispatchedSimple) return;
      await this.delay(120);
      const state = this.peekFindState(app);
      this.popup("peek find state", state, 2600);
      return;
    }

    // 5) 先挂上 first-match 监听器，再 dispatch find。
    //    PDF.js 的搜索是异步分页的；对小 PDF 来说，搜索可能在 dispatch 后
    //    数毫秒内就把若干页的 updatefindmatchescount 事件全部派发完。如果
    //    我们先 dispatch、再 attach，listener 会错过这些早期事件，只能靠
    //    polling 兜底——而 polling 在第一次"ready=true"就会停掉，可能在
    //    搜索状态尚未稳定时就锁定到错误的 pageIdx。先 attach 才能确保
    //    每一次 updatefindmatchescount 都被我们看到。
    this.forceFirstDetach = this.attachGlobalFirstMatchMarker(
      app,
      reader,
      selected,
    );

    // 6) 触发 find：不打开 findbar，减少 UI 干扰；caseSensitive=true 解决 Φ/φ 混淆
    const dispatched = this.dispatchEventBus(app, w, "find", {
      query: selected,
      caseSensitive: this.CASE_SENSITIVE,
      entireWord: this.shouldSearchEntireWord(selected),
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
    if (!dispatched) {
      this.detachContinuousForceFirst();
      return;
    }

    await this.delay(this.AFTER_FIND_FORCE_FIRST_DELAY_MS);
    const forcedPageIdx = this.markGlobalFirstMatch(app, reader, selected);
    this.popup(
      "markGlobalFirstMatch()",
      forcedPageIdx >= 0 ? `OK firstPageIdx=${forcedPageIdx}` : "SKIP/FAILED",
      2200,
    );

    // 7) 解除滚动锁（若设置了）
    if (unlock) {
      // 锁函数内部会自动定时解锁；这里额外提示即可
      this.popup("scroll lock", "will auto-release", 1200);
    }

    // 8) 回读状态（用于确认 controller 接收 query）
    await this.delay(120);
    const state = this.peekFindState(app);
    this.popup("peek find state", state, 2600);

    // 9) 诊断弹窗：在搜索应当结束的时刻拍一份"决策依据"快照给用户看
    if (this.DIAGNOSE_FIRST_MATCH) {
      const remainingDelay =
        this.DIAGNOSE_DELAY_MS - this.AFTER_FIND_FORCE_FIRST_DELAY_MS - 120;
      setTimeout(
        () => this.showFirstMatchDiagnostic(app, reader, selected),
        Math.max(remainingDelay, 0),
      );
    }
  }

  // 取 PDF.js viewer 真正所在的 document。
  // Zotero 的 reader 把 PDF.js viewer 套在内层 iframe 里：
  //   outer iframe (reader._iframeWindow) - 暴露 PDFViewerApplication
  //     └─ inner iframe (PDF.js viewer.html) - 这里才是真正的 viewer DOM
  // 我们注入的 CSS / 查询的 .highlight、.textLayer 必须用这个内层
  // document，否则一切都打不到目标——这是诊断弹窗里 tlInDoc=false /
  // doc(textLayer)=0 的根因。
  private static getPdfDoc(app: any, reader?: Reader): Document | null {
    try {
      const fromContainer = app?.pdfViewer?.container?.ownerDocument;
      if (fromContainer) return fromContainer as Document;
    } catch {
      /* ignore */
    }
    try {
      const fromViewerEl = app?.pdfViewer?.viewer?.ownerDocument;
      if (fromViewerEl) return fromViewerEl as Document;
    } catch {
      /* ignore */
    }
    try {
      const fromAppConfig = app?.appConfig?.mainContainer?.ownerDocument;
      if (fromAppConfig) return fromAppConfig as Document;
    } catch {
      /* ignore */
    }
    try {
      const firstPage = app?.pdfViewer?._pages?.[0];
      const fromPage =
        firstPage?.div?.ownerDocument ??
        firstPage?.textLayer?.div?.ownerDocument;
      if (fromPage) return fromPage as Document;
    } catch {
      /* ignore */
    }
    // 最后兜底：返回外层 reader 的 document。这条路径会让 CSS 注入失败，
    // 但比 null 强 —— 至少 caller 不会立刻崩。
    return reader?._iframeWindow?.document ?? null;
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
        entireWord: false,
        findPrevious: undefined,
      });
    } catch (e) {
      this.log(`clearPdfJsFind failed: ${String(e)}`);
      return false;
    }
  }

  private static shouldSearchEntireWord(query: string): boolean {
    return this.ENTIRE_WORD_FOR_SINGLE_ASCII && /^[A-Za-z]$/.test(query);
  }

  private static detachContinuousForceFirst() {
    const detach = this.forceFirstDetach;
    this.forceFirstDetach = null;
    if (!detach) return;
    try {
      detach();
    } catch (e) {
      this.log(`detachContinuousForceFirst failed: ${String(e)}`);
    }
  }

  private static releaseScrollLock() {
    const unlock = this.scrollUnlock;
    this.scrollUnlock = null;
    if (!unlock) return;
    try {
      unlock();
    } catch (e) {
      this.log(`releaseScrollLock failed: ${String(e)}`);
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
      const win = container.ownerDocument?.defaultView as any;
      const origScrollIntoView = win?.Element?.prototype?.scrollIntoView;
      const origContainerScroll = container.scroll;
      const origContainerScrollTo = container.scrollTo;
      const origContainerScrollBy = container.scrollBy;

      if (fc && typeof fc.scrollMatchIntoView === "function") {
        fc.scrollMatchIntoView = function () {
          /* no-op */
        };
      }
      if (
        win?.Element?.prototype &&
        typeof win.Element.prototype.scrollIntoView === "function"
      ) {
        win.Element.prototype.scrollIntoView = function () {
          /* no-op */
        };
      }
      try {
        if (typeof container.scroll === "function") {
          container.scroll = function () {
            /* no-op */
          };
        }
        if (typeof container.scrollTo === "function") {
          container.scrollTo = function () {
            /* no-op */
          };
        }
        if (typeof container.scrollBy === "function") {
          container.scrollBy = function () {
            /* no-op */
          };
        }
      } catch {
        /* ignore */
      }
      if (
        app?.pdfViewer &&
        typeof app.pdfViewer.scrollPageIntoView === "function"
      ) {
        app.pdfViewer.scrollPageIntoView = function () {
          /* no-op */
        };
      }

      // 2) 一次性回到 snap：仅在 0 / 50 / 150 ms 三个时点同步把视图拉回原位置，
      //    覆盖 PDF.js 在 dispatch find 后立即/异步触发的极少数不走 method patch
      //    的滚动路径。之后就完全不再监听/拦截 scroll，把控制权交还用户。
      //    注意：此前版本曾用持续 scroll 事件回滚做“双保险”，但会拦截用户主动滚动，
      //    用户感觉“被拉回”；wheel/keydown 信号在 Zotero reader 里不可靠（监听不到），
      //    所以这里改为短窗口的脉冲式回滚 + 长期 method patch 的组合方案。
      const restoreToSnap = () => {
        try {
          if (container.scrollTop !== snap.scrollTop)
            container.scrollTop = snap.scrollTop;
          if (container.scrollLeft !== snap.scrollLeft)
            container.scrollLeft = snap.scrollLeft;
        } catch {
          /* ignore */
        }
      };
      restoreToSnap();
      for (const ms of [50, 150, 300, 600, 1000, 1400]) {
        setTimeout(restoreToSnap, ms);
      }

      let hardRestoreActive = true;
      const onScroll = () => {
        if (!hardRestoreActive) return;
        restoreToSnap();
      };
      try {
        container.addEventListener("scroll", onScroll, { passive: true });
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        hardRestoreActive = false;
        try {
          container.removeEventListener("scroll", onScroll);
        } catch {
          /* ignore */
        }
      }, this.HARD_SCROLL_RESTORE_MS);

      // 3) 方法 patch 在 durationMs 后恢复（覆盖整个搜索过程，阻止 PDF.js 主动跳页）
      let methodPatchActive = true;
      const unlock = () => {
        if (!methodPatchActive) return;
        methodPatchActive = false;

        try {
          if (fc && origScrollMatch && typeof origScrollMatch === "function") {
            fc.scrollMatchIntoView = origScrollMatch;
          }
        } catch {
          /* ignore */
        }

        try {
          if (
            app?.pdfViewer &&
            origScrollPageIntoView &&
            typeof origScrollPageIntoView === "function"
          ) {
            app.pdfViewer.scrollPageIntoView = origScrollPageIntoView;
          }
        } catch {
          /* ignore */
        }

        try {
          if (
            win?.Element?.prototype &&
            origScrollIntoView &&
            typeof origScrollIntoView === "function"
          ) {
            win.Element.prototype.scrollIntoView = origScrollIntoView;
          }
        } catch {
          /* ignore */
        }

        try {
          if (origContainerScroll) container.scroll = origContainerScroll;
          if (origContainerScrollTo) container.scrollTo = origContainerScrollTo;
          if (origContainerScrollBy) container.scrollBy = origContainerScrollBy;
        } catch {
          /* ignore */
        }

        hardRestoreActive = false;
        try {
          container.removeEventListener("scroll", onScroll);
        } catch {
          /* ignore */
        }
      };

      setTimeout(unlock, durationMs);

      return unlock;
    } catch (e) {
      this.log(`lockScroll failed: ${String(e)}`);
      return null;
    }
  }

  private static markGlobalFirstMatch(
    app: any,
    reader: Reader,
    query: string,
  ): number {
    try {
      const result = this.getGlobalFirstMatchPageIdx(app, query);
      if (!result.ready || result.pageIdx < 0) {
        return -1;
      }

      const marked = this.applyFirstMatchMarkerToPage(
        app,
        reader,
        result.pageIdx,
      );
      if (marked) {
        this.lastMarkerAppliedPageIdx = result.pageIdx;
        this.commitHoverContext(reader, app, query, result.pageIdx);
        return result.pageIdx;
      }
      return -1;
    } catch (e) {
      this.log(`markGlobalFirstMatch failed: ${String(e)}`);
      return -1;
    }
  }

  // 找到“全文第一次出现”所在的 pageIdx。
  // 关键：必须等到从第 0 页起、连续每一页都已被 PDF.js 实际搜索过，
  // 才能断言谁是"第一个"。否则用户在中间某页选词时，由于当前页最先被
  // 搜索，会被误当成"全文第一个"。
  // 优先用 findController.pageMatches/_pageMatches（PDF.js 的权威结果），
  // 因为：
  //  - 未搜索过的页是 undefined，已搜索过的页是数组（可能为空）；
  //  - 不存在 _pageContents 的"归一化文本 vs 原始 query"不匹配问题。
  // _pageContents + 朴素 includes 只在 pageMatches 不可用时作为兜底。
  private static getGlobalFirstMatchPageIdx(
    app: any,
    query: string,
  ): GlobalFirstMatchResult {
    try {
      const fc = app?.findController;
      if (!fc) return { ready: false, pageIdx: -1 };

      const pageMatches = fc?.pageMatches ?? fc?._pageMatches ?? null;
      const pageContents = fc?._pageContents ?? null;

      const pageCount = this.getPdfPageCount(
        app,
        Array.isArray(pageMatches)
          ? pageMatches
          : Array.isArray(pageContents)
            ? pageContents
            : [],
      );
      if (pageCount <= 0) return { ready: false, pageIdx: -1 };

      // 关键：要断言"全文第一次出现"在第 i 页，必须先确认 PDF.js 已经
      // 真正搜过 [0, i] 之间所有页面（否则前面某页可能还在排队，等扫
      // 描完才会显出更早的匹配）。
      //
      // 单看 _pageMatches[i] 是不是数组并不可靠：在某些 PDF.js 版本/分支
      // 中，_pageMatches 可能在搜索开始时就被初始化为长度等于 pageCount
      // 的空数组数组，或者 _calculateMatch 进入时先写入 `[]` 占位再填充。
      // 这样的话，"是数组"就不能等同于"已经搜过"，会被当前页（最先被搜索）
      // 之前的占位空数组误导，把当前页判成全文第一个。
      //
      // 所以这里要求两个证据都到位：
      //   1) _pageMatches[i] 是数组（_calculateMatch 已经为该页结束）；
      //   2) _pageContents[i] 是字符串（该页的文本提取已完成；
      //      _pageContents[i] = strBuf.join('') 是 _calculateMatch 之前
      //      就发生的，所以"内容已就绪 + 匹配已就绪"是更强的"搜过"信号）。
      // 当 _pageContents 完全不存在时，回退到只用 pageMatches（旧行为）。
      const hasContents = Array.isArray(pageContents);

      if (Array.isArray(pageMatches)) {
        for (let i = 0; i < pageCount; i++) {
          const matchesOnPage = pageMatches[i];
          if (!Array.isArray(matchesOnPage)) {
            return { ready: false, pageIdx: -1 };
          }
          if (hasContents && typeof pageContents[i] !== "string") {
            // 文本提取还没到这一页 —— 即便 _pageMatches[i] 看上去
            // 是空数组，也只是初始化占位，不代表"搜过且无匹配"。
            return { ready: false, pageIdx: -1 };
          }
          if (matchesOnPage.length > 0) {
            return { ready: true, pageIdx: i };
          }
        }
        return { ready: true, pageIdx: -1 };
      }

      // 没有 pageMatches，只能退回到对 _pageContents 做朴素 includes。
      // 注意 PDF.js 可能对 _pageContents 做归一化（例如去重音符），
      // 因此该路径精度不如 pageMatches，仅在前者完全缺失时使用。
      if (Array.isArray(pageContents)) {
        if (pageContents.length < pageCount) {
          return { ready: false, pageIdx: -1 };
        }
        for (let i = 0; i < pageCount; i++) {
          if (typeof pageContents[i] !== "string") {
            return { ready: false, pageIdx: -1 };
          }
        }
        for (let i = 0; i < pageCount; i++) {
          if (this.countMatchesOnPage(fc, query, pageContents[i], i) > 0) {
            return { ready: true, pageIdx: i };
          }
        }
        return { ready: true, pageIdx: -1 };
      }

      return { ready: false, pageIdx: -1 };
    } catch (e) {
      this.log(`getGlobalFirstMatchPageIdx failed: ${String(e)}`);
      return { ready: false, pageIdx: -1 };
    }
  }

  private static countMatchesOnPage(
    fc: any,
    query: string,
    pageContent: string,
    pageIdx: number,
  ): number {
    try {
      if (typeof fc?.match === "function") {
        const matches = fc.match(query, pageContent, pageIdx);
        if (Array.isArray(matches)) return matches.length;
      }
    } catch {
      /* fall through to plain text matching */
    }

    const haystack = this.CASE_SENSITIVE
      ? pageContent
      : pageContent.toLocaleLowerCase();
    const needle = this.CASE_SENSITIVE ? query : query.toLocaleLowerCase();
    return needle && haystack.includes(needle) ? 1 : 0;
  }

  private static getPdfPageCount(app: any, pageMatches: unknown[]): number {
    const candidates = [
      app?.pagesCount,
      app?.pdfDocument?.numPages,
      app?.pdfViewer?.pagesCount,
      app?.pdfViewer?._pages?.length,
      app?.findController?._linkService?.pagesCount,
      pageMatches.length,
    ];

    for (const candidate of candidates) {
      const n = Number(candidate);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  private static applyFirstMatchMarkerToPage(
    app: any,
    reader: Reader,
    pageIdx: number,
  ): boolean {
    try {
      // 使用 PDF.js viewer 真正所在的 document（内层 iframe），而不是
      // reader._iframeWindow.document（外层）。否则 CSS 注入会失败、
      // doc.querySelector 也查不到任何 .highlight。
      const doc: Document | null = this.getPdfDoc(app, reader);
      if (!doc) return false;

      this.injectHighlightStyles(doc);
      this.clearFirstMatchMarker(doc);
      this.clearPdfJsSelectedMatch(doc);
      this.lastMarkerDoc = doc;

      const pageNumber = pageIdx + 1;
      const pageView = app?.pdfViewer?._pages?.[pageIdx] ?? null;
      const textLayerDiv =
        pageView?.textLayer?.div ??
        pageView?.textLayer?.textLayerDiv ??
        doc.querySelector(`.page[data-page-number="${pageNumber}"] .textLayer`);
      if (!textLayerDiv) return false;

      const highlights = Array.from(
        textLayerDiv.querySelectorAll(".highlight"),
      ) as HTMLElement[];
      if (!highlights.length) return false;

      const firstHighlight = highlights[0];
      firstHighlight.classList.add(this.FIRST_MARK_CLASS);

      // Multi-span matches in PDF.js may be split into begin/middle/end nodes.
      if (firstHighlight.classList.contains("begin")) {
        for (let i = 1; i < highlights.length; i++) {
          const hl = highlights[i];
          if (hl.classList.contains("begin")) break;
          hl.classList.add(this.FIRST_MARK_CLASS);
          if (hl.classList.contains("end")) break;
        }
      }

      return true;
    } catch (e) {
      this.log(`applyFirstMatchMarkerToPage failed: ${String(e)}`);
      return false;
    }
  }

  private static prepareReaderHighlightStyles(reader: Reader, app: any) {
    try {
      const doc = this.getPdfDoc(app, reader);
      if (!doc) return;
      this.injectHighlightStyles(doc);
      this.clearPdfJsSelectedMatch(doc);
    } catch (e) {
      this.log(`prepareReaderHighlightStyles failed: ${String(e)}`);
    }
  }

  private static injectHighlightStyles(doc: Document) {
    this.injectSuppressSelectedStyle(doc);
    this.injectFirstMatchStyle(doc);
  }

  private static injectSuppressSelectedStyle(doc: Document) {
    if (
      doc.head?.querySelector(`style[${this.SUPPRESS_SELECTED_STYLE_ATTR}]`)
    ) {
      return;
    }

    // 现在 CSS 已经注入到 PDF.js viewer 真正的 document 里，可以做最小化
    // 的样式覆盖：
    //  - 普通 .highlight（非 .selected、非我们的 marker）：完全保留 PDF.js
    //    默认颜色（橙/黄），不去动。
    //  - .highlight.selected （PDF.js 自己选中的"当前匹配"，默认深绿色）：
    //    如果它不是我们的 marker，强制回退到普通 highlight 颜色，避免被
    //    误以为是"全文第一个"。
    //  - .highlight.${this.FIRST_MARK_CLASS}（我们标的全文第一个）：绿色。
    const style = doc.createElement("style");
    style.setAttribute(this.SUPPRESS_SELECTED_STYLE_ATTR, "1");
    style.textContent = `
.textLayer .highlight.selected:not(.${this.FIRST_MARK_CLASS}) {
  --highlight-selected-bg-color: var(--highlight-bg-color) !important;
  --find-highlight-selected-bg-color: var(--find-highlight-bg-color, var(--highlight-bg-color)) !important;
  background-color: var(--highlight-bg-color) !important;
  background: var(--highlight-bg-color) !important;
  outline: none !important;
  box-shadow: none !important;
}
.textLayer .highlight.${this.FIRST_MARK_CLASS},
.textLayer .highlight.${this.FIRST_MARK_CLASS}.selected,
.textLayer .highlight.${this.FIRST_MARK_CLASS}.appended,
.textLayer .highlight.${this.FIRST_MARK_CLASS}.appended.selected {
  --highlight-bg-color: rgba(0, 180, 80, 0.55) !important;
  --highlight-selected-bg-color: rgba(0, 180, 80, 0.55) !important;
  --find-highlight-bg-color: rgba(0, 180, 80, 0.55) !important;
  --find-highlight-selected-bg-color: rgba(0, 180, 80, 0.55) !important;
  background: rgba(0, 180, 80, 0.55) !important;
  background-color: rgba(0, 180, 80, 0.55) !important;
  outline: 1px solid rgba(0, 120, 55, 0.75) !important;
}
`;
    const host = doc.head ?? doc.documentElement;
    host?.appendChild(style);
  }

  private static injectFirstMatchStyle(doc: Document) {
    if (doc.head?.querySelector(`style[${this.FIRST_MARK_STYLE_ATTR}]`)) return;

    const style = doc.createElement("style");
    style.setAttribute(this.FIRST_MARK_STYLE_ATTR, "1");
    style.textContent = `
.textLayer .highlight.${this.FIRST_MARK_CLASS} {
  background-color: rgba(0, 180, 80, 0.55) !important;
  outline: 1px solid rgba(0, 120, 55, 0.75) !important;
}
`;
    const host = doc.head ?? doc.documentElement;
    host?.appendChild(style);
  }

  // 检查我们的 marker class 是否还贴在指定 pageIdx 的 textLayer 里。
  // 直接用 pageView.textLayer.div 这个引用查 —— 比通过 doc + .page 选择
  // 器更可靠，因为 Zotero 的 PDF.js 里 .page[data-page-number] 这条路径
  // 不一定能命中（已经在诊断里证实过 pageElBySel=false）。
  private static isMarkerInDomOnPage(
    reader: Reader,
    app: any,
    pageIdx: number,
  ): boolean {
    try {
      const pageView = app?.pdfViewer?._pages?.[pageIdx] ?? null;
      const textLayerDiv: HTMLElement | null =
        pageView?.textLayer?.div ??
        pageView?.textLayer?.textLayerDiv ??
        null;
      if (!textLayerDiv) {
        const doc: Document | null = this.getPdfDoc(app, reader);
        if (!doc) return false;
        const fallback = doc.querySelector(`.${this.FIRST_MARK_CLASS}`);
        return fallback !== null;
      }
      return (
        textLayerDiv.querySelector(`.${this.FIRST_MARK_CLASS}`) !== null
      );
    } catch {
      return false;
    }
  }

  private static clearFirstMatchMarker(doc?: Document | null) {
    const docs = [doc ?? this.lastMarkerDoc].filter(Boolean) as Document[];

    for (const currentDoc of docs) {
      try {
        for (const el of Array.from(
          currentDoc.querySelectorAll(`.${this.FIRST_MARK_CLASS}`),
        ) as Element[]) {
          el.classList.remove(this.FIRST_MARK_CLASS);
        }
      } catch {
        /* ignore */
      }
    }

    if (!doc) this.lastMarkerDoc = null;
  }

  private static clearPdfJsSelectedMatch(doc: Document) {
    try {
      for (const el of Array.from(
        doc.querySelectorAll(".textLayer .highlight.selected"),
      ) as Element[]) {
        el.classList.remove("selected");
      }
    } catch {
      /* ignore */
    }
  }

  private static clearPdfJsSelectedMatchForReader(reader: Reader, app: any) {
    try {
      const doc = this.getPdfDoc(app, reader);
      if (doc) this.clearPdfJsSelectedMatch(doc);
    } catch {
      /* ignore */
    }
  }

  private static attachGlobalFirstMatchMarker(
    app: any,
    reader: Reader,
    query: string,
  ): () => void {
    const noop = () => {};
    try {
      const eb = app?.eventBus;
      if (!eb || typeof eb.on !== "function" || typeof eb.off !== "function") {
        return noop;
      }

      let lastFirstPageIdx = -1;
      let stableCount = 0;
      let attempts = 0;
      let applied = false;
      let searchSettled = false;
      let detached = false;
      let pollTimer: number | null = null;
      let timeoutTimer: number | null = null;

      const detach = () => {
        if (detached) return;
        detached = true;
        try {
          eb.off("updatefindmatchescount", handler);
        } catch {
          /* ignore */
        }
        try {
          eb.off("textlayerrendered", textLayerHandler);
        } catch {
          /* ignore */
        }
        try {
          eb.off("updatetextlayermatches", matchesUpdatedHandler);
        } catch {
          /* ignore */
        }
        try {
          if (pollTimer != null) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch {
          /* ignore */
        }
        try {
          if (timeoutTimer != null) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
        } catch {
          /* ignore */
        }
        if (this.forceFirstDetach === detach) {
          this.forceFirstDetach = null;
        }
        this.popup(
          "attachGlobalFirstMatchMarker detach",
          `attempts=${attempts} lastFirstPageIdx=${lastFirstPageIdx} applied=${applied}`,
          1200,
        );
      };

      // 同步重贴：去掉之前的 setTimeout(0) + markerScheduled debounce。
      // 之前设计是为了批合并多次调用避免抖动，但现在的核心问题是 PDF.js
      // 反复重建 textLayer 把 class 冲掉，我们要"立即"补贴。任何延迟都
      // 会让用户在中间看到默认绿色。同步执行也比较好排查 —— 谁触发的
      // reapply 一目了然。
      const reapplyNow = () => {
        if (detached) return;
        const markedPageIdx = this.markGlobalFirstMatch(app, reader, query);
        if (markedPageIdx >= 0) {
          lastFirstPageIdx = markedPageIdx;
          applied = true;
        }
      };

      const handler = (_data?: any) => {
        if (detached) return;
        attempts++;

        this.clearPdfJsSelectedMatchForReader(reader, app);

        const firstResult = this.getGlobalFirstMatchPageIdx(app, query);
        if (!firstResult.ready) {
          if (attempts >= this.FORCE_FIRST_MAX_ATTEMPTS) detach();
          return;
        }

        searchSettled = true;
        // 不在 ready=true 就停 polling。PDF.js 会在 updatetextlayermatches
        // 时把 textLayer 里的 .highlight span 整体重建，把我们贴的
        // .zvh-global-first-match class 一起冲掉，所以必须周期性"补贴"。

        const firstPageIdx = firstResult.pageIdx;
        if (firstPageIdx < 0) {
          detach();
          return;
        }

        // 一次轮询里：
        // 1) 如果 firstPageIdx 变了，重新打 marker；
        // 2) 如果 firstPageIdx 没变但 marker 不在 DOM 里，补贴。
        const markerStillInDom = this.isMarkerInDomOnPage(
          reader,
          app,
          firstPageIdx,
        );

        if (firstPageIdx !== lastFirstPageIdx) {
          lastFirstPageIdx = firstPageIdx;
          stableCount = 0;
          reapplyNow();
        } else if (!applied || !markerStillInDom) {
          stableCount = 0;
          reapplyNow();
        } else {
          stableCount++;
        }

        if (attempts >= this.FORCE_FIRST_MAX_ATTEMPTS) {
          detach();
        }
      };

      const textLayerHandler = (data: any) => {
        if (detached) return;
        const pageNumber = Number(data?.pageNumber);
        if (
          searchSettled &&
          lastFirstPageIdx >= 0 &&
          pageNumber === lastFirstPageIdx + 1
        ) {
          reapplyNow();
        }
      };

      // 关键事件：PDF.js 的 TextHighlighter 监听这个事件，每次它把
      // 目标页 textLayer 里的 .highlight span 整体重建后都会派发。
      // 我们贴在事件链最后再补一次 marker，这样 PDF.js 拆完我们立刻补回。
      const matchesUpdatedHandler = (data: any) => {
        if (detached) return;
        if (!searchSettled || lastFirstPageIdx < 0) return;
        const pageIndex = Number(data?.pageIndex);
        // pageIndex === -1 表示所有页都被通知；否则只通知特定页
        if (
          Number.isNaN(pageIndex) ||
          pageIndex === -1 ||
          pageIndex === lastFirstPageIdx
        ) {
          reapplyNow();
        }
      };

      eb.on("updatefindmatchescount", handler);
      try {
        eb.on("textlayerrendered", textLayerHandler);
      } catch {
        /* ignore */
      }
      try {
        eb.on("updatetextlayermatches", matchesUpdatedHandler);
      } catch {
        /* ignore */
      }
      pollTimer = setInterval(
        handler,
        this.FORCE_FIRST_POLL_INTERVAL_MS,
      ) as unknown as number;

      // 兜底超时
      timeoutTimer = setTimeout(
        detach,
        this.FORCE_FIRST_TIMEOUT_MS,
      ) as unknown as number;

      return detach;
    } catch (e) {
      this.log(`attachGlobalFirstMatchMarker failed: ${String(e)}`);
      return noop;
    }
  }

  private static commitHoverContext(
    reader: Reader,
    app: any,
    query: string,
    pageIdx: number,
  ) {
    try {
      const fc = app?.findController;
      const pageMatches = fc?.pageMatches ?? fc?._pageMatches ?? null;
      const pageMatchesLength =
        fc?.pageMatchesLength ?? fc?._pageMatchesLength ?? null;
      let matchOffset: { index: number; length: number } | undefined;
      const indexAt = pageMatches?.[pageIdx]?.[0];
      const lenAt = pageMatchesLength?.[pageIdx]?.[0];
      if (typeof indexAt === "number" && typeof lenAt === "number") {
        matchOffset = { index: indexAt, length: lenAt };
      }
      if (this.ENABLE_HOVER_PREVIEW) {
        HoverPreview.onFindCommitted(reader, {
          query,
          pageIdx,
          matchOffset,
        });
      }
    } catch (e) {
      this.log(`commitHoverContext failed: ${String(e)}`);
    }
  }

  // 一次性诊断弹窗：在 dispatch find 之后 DIAGNOSE_DELAY_MS 触发。
  // 弹出 Zotero.ProgressWindow，列出我们判断"全文第一个"所依据的关键状态。
  // 用法：DIAGNOSE_FIRST_MATCH = true → npm run build → 重装 Zotero 插件
  // → 选一个你认为"前面页就出现过"的符号 → 等弹窗 → 把弹窗截图发出来。
  private static showFirstMatchDiagnostic(
    app: any,
    reader: Reader,
    query: string,
  ) {
    try {
      const fc = app?.findController;
      const pageMatches = fc?.pageMatches ?? fc?._pageMatches ?? null;
      const pageContents = fc?._pageContents ?? null;
      const currentPage =
        Number(app?.pdfViewer?.currentPageNumber) ||
        Number(app?.page) ||
        -1;
      const pageCount =
        Number(app?.pagesCount) ||
        Number(app?.pdfDocument?.numPages) ||
        Number(app?.pdfViewer?.pagesCount) ||
        (Array.isArray(pageMatches) ? pageMatches.length : 0);

      const result = this.getGlobalFirstMatchPageIdx(app, query);
      const peek = this.peekFindState(app);

      // 前 N 页（或到第一个有匹配的页为止）的状态
      const dumpUpto = Math.min(
        this.DIAGNOSE_PAGES_TO_DUMP,
        pageCount > 0 ? pageCount : this.DIAGNOSE_PAGES_TO_DUMP,
      );
      const lines: string[] = [];
      for (let i = 0; i < dumpUpto; i++) {
        const m = Array.isArray(pageMatches) ? pageMatches[i] : undefined;
        const c = Array.isArray(pageContents) ? pageContents[i] : undefined;
        const mDesc = Array.isArray(m) ? `m=${m.length}` : "m=?";
        const cDesc =
          typeof c === "string" ? `c=${c.length}` : `c=${typeof c}`;
        lines.push(`p${i + 1}: ${mDesc} ${cDesc}`);
      }

      // 顺带看一下 marker 实际打在了 DOM 哪个元素上
      // 同时分两路查：doc 全局查 + 直接通过 pageView.textLayer.div 查
      let markerElDesc = "(none)";
      try {
        const doc: Document | null =
          this.getPdfDoc(app, reader) ?? this.lastMarkerDoc;
        const targetIdx = result.ready
          ? result.pageIdx
          : this.lastMarkerAppliedPageIdx;
        const pageView = app?.pdfViewer?._pages?.[targetIdx] ?? null;
        const tlDirect: HTMLElement | null =
          pageView?.textLayer?.div ??
          pageView?.textLayer?.textLayerDiv ??
          null;

        const docCount = doc
          ? doc.querySelectorAll(`.${this.FIRST_MARK_CLASS}`).length
          : -1;
        const directCount = tlDirect
          ? tlDirect.querySelectorAll(`.${this.FIRST_MARK_CLASS}`).length
          : -1;

        if (docCount > 0) {
          const first = doc!.querySelector(
            `.${this.FIRST_MARK_CLASS}`,
          ) as Element;
          const pageEl = first.closest("[data-page-number]") as
            | HTMLElement
            | null;
          const pageNum =
            pageEl?.getAttribute("data-page-number") ?? "?";
          markerElDesc = `doc=${docCount} direct=${directCount} domPage=${pageNum} text="${(first.textContent || "").slice(0, 20)}"`;
        } else {
          markerElDesc = `doc=${docCount} direct=${directCount}`;
        }
      } catch (e) {
        markerElDesc = `(err: ${String(e)})`;
      }

      // 关键扩展：直接看目标页（chosenPageIdx）现在 textLayer 里到底有
      // 多少个 .highlight。同时确认这个 textLayer 是否真的接进了 doc 树。
      let targetPageDom = "(no-target)";
      let parentChain = "(no-target)";
      try {
        const targetIdx = result.ready
          ? result.pageIdx
          : this.lastMarkerAppliedPageIdx;
        if (targetIdx >= 0) {
          const doc: Document | null = this.getPdfDoc(app, reader);
          const pageView = app?.pdfViewer?._pages?.[targetIdx] ?? null;
          const tlDirect: HTMLElement | null =
            pageView?.textLayer?.div ?? pageView?.textLayer?.textLayerDiv ?? null;
          const hlCount = tlDirect
            ? tlDirect.querySelectorAll(".highlight").length
            : -1;
          const tlInDoc = !!(doc && tlDirect && doc.contains(tlDirect));
          const tlAllCount = doc
            ? doc.querySelectorAll(".textLayer").length
            : -1;
          const hlAllCount = doc
            ? doc.querySelectorAll(".highlight").length
            : -1;
          const pageNumByDataAttr = doc
            ? doc.querySelectorAll("[data-page-number]").length
            : -1;
          targetPageDom = `pageIdx=${targetIdx} pageView=${!!pageView} tlDirect=${!!tlDirect} hl=${hlCount} tlInDoc=${tlInDoc} doc(textLayer)=${tlAllCount} doc(.highlight)=${hlAllCount} doc([data-page-number])=${pageNumByDataAttr}`;

          // 父链：从 textLayerDiv 一路向上，dump 每层 tag/class/id
          if (tlDirect) {
            const chain: string[] = [];
            let node: Element | null = tlDirect;
            let depth = 0;
            while (node && depth < 6) {
              const tag = node.tagName?.toLowerCase() ?? "?";
              const cls = (node as HTMLElement).className
                ? `.${String((node as HTMLElement).className)
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(".")}`
                : "";
              const id = node.id ? `#${node.id}` : "";
              const dpn = node.getAttribute?.("data-page-number")
                ? `[data-page-number=${node.getAttribute("data-page-number")}]`
                : "";
              chain.push(`${tag}${id}${cls}${dpn}`);
              node = node.parentElement;
              depth++;
            }
            parentChain = chain.join(" > ");
          }
        }
      } catch (e) {
        targetPageDom = `(err: ${String(e)})`;
      }

      const headline = `ZVH 诊断 query="${query}"`;
      const summary =
        `currentPage=${currentPage} pageCount=${pageCount} ` +
        `chosenPageIdx=${result.ready ? result.pageIdx : "(not-ready)"} ` +
        `markerPageIdx=${this.lastMarkerAppliedPageIdx} ` +
        `markerInDom=${markerElDesc} ` +
        `target=[${targetPageDom}] ` +
        `pmType=${Array.isArray(pageMatches) ? `Array(${pageMatches.length})` : typeof pageMatches} ` +
        `pcType=${Array.isArray(pageContents) ? `Array(${pageContents.length})` : typeof pageContents} ` +
        `| ${peek}`;

      this.log(`[DIAGNOSE] ${headline} | ${summary}`);
      this.log(`[DIAGNOSE] parentChain: ${parentChain}`);
      for (const line of lines) this.log(`[DIAGNOSE]   ${line}`);

      try {
        const pw = new Zotero.ProgressWindow();
        pw.changeHeadline(headline);
        pw.addDescription(summary);
        pw.addDescription(`parentChain: ${parentChain}`);
        for (const line of lines) pw.addDescription(line);
        pw.show();
        pw.startCloseTimer(15000); // 留 15 秒看清楚 / 截图
      } catch (e) {
        this.log(`showFirstMatchDiagnostic ProgressWindow failed: ${String(e)}`);
      }
    } catch (e) {
      this.log(`showFirstMatchDiagnostic failed: ${String(e)}`);
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
