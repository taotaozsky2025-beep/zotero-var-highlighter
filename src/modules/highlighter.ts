import { getPref } from "../utils/prefs";

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
  private static readonly TAG = "ZVH-highlighter-2026-01-29-r7";

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

  // 默认颜色值
  private static readonly DEFAULT_FIRST_MATCH_COLOR = "#00ff00"; // 绿色
  private static readonly DEFAULT_OTHER_MATCH_COLOR = "#ff69b4"; // 粉色

  // 预览窗口配置
  private static readonly PREVIEW_POPUP_WIDTH = 300;
  private static readonly PREVIEW_POPUP_HEIGHT = 200;
  private static readonly PREVIEW_HOVER_DELAY_MS = 500; // 悬停延迟显示

  private static debugSeq = 0;
  private static lastPopupAt = 0;

  private static addon: any;
  private static pluginID = "zotero-var-highlighter@local";

  // 存储当前的第一个匹配信息，用于预览功能
  private static currentFirstMatch: {
    pageIdx: number;
    matchIdx: number;
    app: any;
  } | null = null;

  // 预览窗口相关
  private static previewPopup: HTMLElement | null = null;
  private static hoverTimeout: ReturnType<typeof setTimeout> | null = null;

  // 缓存已注入样式的文档和颜色
  private static injectedStyleDocs: WeakSet<Document> = new WeakSet();
  private static lastInjectedColors: { first: string; other: string } | null =
    null;

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

    // 6) 强制“全文第一次出现”为 current match（绿色）
    //    注意：这一步依赖 PDF.js 内部状态，属于 best-effort
    await this.delay(this.AFTER_FIND_FORCE_FIRST_DELAY_MS);
    const forced = this.forceGlobalFirstAsCurrentMatch(app);
    this.popup(
      "forceGlobalFirstAsCurrentMatch()",
      forced ? "OK (best-effort)" : "SKIP/FAILED",
      2200,
    );

    // 7) 为高亮元素添加悬停预览功能
    await this.delay(100);
    this.setupHoverPreview(app);

    // 8) 解除滚动锁（若设置了）
    if (unlock) {
      // 锁函数内部会自动定时解锁；这里额外提示即可
      this.popup("scroll lock", "will auto-release", 1200);
    }

    // 9) 回读状态（用于确认 controller 接收 query）
    await this.delay(120);
    const state = this.peekFindState(app);
    this.popup("peek find state", state, 2600);
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

      // 存储首次匹配信息，用于预览功能
      this.currentFirstMatch = {
        pageIdx: first.pageIdx,
        matchIdx: first.matchIdx,
        app,
      };

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

      // 强制更新所有页面的高亮层，移除错误的 selected 标记
      // PDF.js 通过 CSS 类 "selected" 来标记当前匹配项
      this.updateHighlightLayers(app, first.pageIdx, first.matchIdx);

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

  /**
   * 更新所有页面的高亮层，确保只有全文第一个匹配项有 "selected" 类。
   * 这是修复"当前页第一个也显示绿色"问题的关键。
   * 同时注入自定义颜色样式。
   */
  private static updateHighlightLayers(
    app: any,
    firstPageIdx: number,
    firstMatchIdx: number,
  ): void {
    try {
      const pdfViewer = app?.pdfViewer;
      if (!pdfViewer) return;

      // 获取用户配置的颜色
      const firstMatchColor = this.getFirstMatchColor();
      const otherMatchColor = this.getOtherMatchColor();

      // 获取所有页面
      const pagesCount = pdfViewer.pagesCount ?? pdfViewer._pages?.length ?? 0;

      for (let pageIdx = 0; pageIdx < pagesCount; pageIdx++) {
        try {
          // 获取页面视图
          const pageView = pdfViewer.getPageView?.(pageIdx);
          if (!pageView) continue;

          // 获取文本层容器
          const textLayerDiv =
            pageView.textLayer?.div ?? pageView.textLayerDiv ?? null;
          if (!textLayerDiv) continue;

          // 注入自定义颜色样式
          this.injectCustomStyles(
            textLayerDiv,
            firstMatchColor,
            otherMatchColor,
          );

          // 查找所有高亮元素
          const highlights = textLayerDiv.querySelectorAll(".highlight");
          if (!highlights || highlights.length === 0) continue;

          // 遍历高亮元素，只有全文第一个匹配项保留 selected 类
          highlights.forEach((el: Element, matchIdx: number) => {
            const isGlobalFirst =
              pageIdx === firstPageIdx && matchIdx === firstMatchIdx;

            if (isGlobalFirst) {
              // 确保全文第一个匹配项有 selected 类
              if (!el.classList.contains("selected")) {
                el.classList.add("selected");
              }
            } else {
              // 移除其他匹配项的 selected 类
              if (el.classList.contains("selected")) {
                el.classList.remove("selected");
              }
            }
          });
        } catch (pageError) {
          // 忽略单个页面的错误，继续处理其他页面
          this.log(`updateHighlightLayers page ${pageIdx} error: ${pageError}`);
        }
      }
    } catch (e) {
      this.log(`updateHighlightLayers failed: ${String(e)}`);
    }
  }

  /**
   * 获取用户配置的首次出现颜色（定义颜色）
   */
  private static getFirstMatchColor(): string {
    try {
      const color = getPref("firstMatchColor");
      return color || this.DEFAULT_FIRST_MATCH_COLOR;
    } catch {
      return this.DEFAULT_FIRST_MATCH_COLOR;
    }
  }

  /**
   * 获取用户配置的其他匹配项颜色
   */
  private static getOtherMatchColor(): string {
    try {
      const color = getPref("otherMatchColor");
      return color || this.DEFAULT_OTHER_MATCH_COLOR;
    } catch {
      return this.DEFAULT_OTHER_MATCH_COLOR;
    }
  }

  /**
   * 注入自定义颜色样式到文本层
   * 使用缓存避免重复更新样式
   */
  private static injectCustomStyles(
    textLayerDiv: Element,
    firstMatchColor: string,
    otherMatchColor: string,
  ): void {
    try {
      const doc = textLayerDiv.ownerDocument;
      if (!doc) return;

      // 检查颜色是否已更改，如果没有更改且已注入样式，则跳过
      const colorsUnchanged =
        this.lastInjectedColors?.first === firstMatchColor &&
        this.lastInjectedColors?.other === otherMatchColor;
      if (colorsUnchanged && this.injectedStyleDocs.has(doc)) {
        return;
      }

      const styleId = "zvh-custom-highlight-styles";
      let styleEl = doc.getElementById(styleId) as HTMLStyleElement | null;

      // 创建或更新样式元素
      if (!styleEl) {
        styleEl = doc.createElement("style");
        styleEl.id = styleId;
        doc.head?.appendChild(styleEl);
      }

      // 设置自定义颜色样式
      // PDF.js 使用 .highlight 类标记所有匹配项，.highlight.selected 标记当前选中项
      styleEl.textContent = `
        .textLayer .highlight {
          background-color: ${otherMatchColor} !important;
        }
        .textLayer .highlight.selected {
          background-color: ${firstMatchColor} !important;
        }
      `;

      // 更新缓存
      this.lastInjectedColors = {
        first: firstMatchColor,
        other: otherMatchColor,
      };
      this.injectedStyleDocs.add(doc);
    } catch (e) {
      this.log(`injectCustomStyles failed: ${String(e)}`);
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

  /**
   * 设置悬停预览功能
   * 当用户将鼠标悬停在高亮元素上时，显示首次出现位置的预览
   */
  private static setupHoverPreview(app: any): void {
    try {
      if (!this.currentFirstMatch) {
        this.log("setupHoverPreview: no first match stored");
        return;
      }

      const pdfViewer = app?.pdfViewer;
      if (!pdfViewer) return;

      const pagesCount = pdfViewer.pagesCount ?? pdfViewer._pages?.length ?? 0;

      for (let pageIdx = 0; pageIdx < pagesCount; pageIdx++) {
        try {
          const pageView = pdfViewer.getPageView?.(pageIdx);
          if (!pageView) continue;

          const textLayerDiv =
            pageView.textLayer?.div ?? pageView.textLayerDiv ?? null;
          if (!textLayerDiv) continue;

          const highlights = textLayerDiv.querySelectorAll(".highlight");
          if (!highlights || highlights.length === 0) continue;

          // 为每个高亮元素添加悬停事件
          highlights.forEach((el: Element) => {
            // 跳过首次出现的元素（它已经是绿色的定义位置）
            if (el.classList.contains("selected")) return;

            const htmlEl = el as HTMLElement;

            // 检查是否已经添加了事件监听器（通过数据属性标记）
            if (htmlEl.dataset.zvhHoverSetup === "true") return;

            // 添加事件监听器
            htmlEl.addEventListener(
              "mouseenter",
              this.handleHighlightMouseEnter,
            );
            htmlEl.addEventListener(
              "mouseleave",
              this.handleHighlightMouseLeave,
            );

            // 标记已设置
            htmlEl.dataset.zvhHoverSetup = "true";

            // 设置样式以便悬停
            htmlEl.style.cursor = "pointer";
          });
        } catch (pageError) {
          this.log(`setupHoverPreview page ${pageIdx} error: ${pageError}`);
        }
      }
    } catch (e) {
      this.log(`setupHoverPreview failed: ${String(e)}`);
    }
  }

  /**
   * 处理高亮元素的鼠标进入事件
   */
  private static handleHighlightMouseEnter = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (!target) return;

    // 清除之前的定时器
    if (Highlighter.hoverTimeout !== null) {
      clearTimeout(Highlighter.hoverTimeout);
    }

    // 延迟显示预览窗口
    Highlighter.hoverTimeout = globalThis.setTimeout(() => {
      Highlighter.showPreviewPopup(event.clientX, event.clientY);
    }, Highlighter.PREVIEW_HOVER_DELAY_MS);
  };

  /**
   * 处理高亮元素的鼠标离开事件
   */
  private static handleHighlightMouseLeave = (): void => {
    // 清除定时器
    if (Highlighter.hoverTimeout !== null) {
      clearTimeout(Highlighter.hoverTimeout);
      Highlighter.hoverTimeout = null;
    }

    // 隐藏预览窗口
    Highlighter.hidePreviewPopup();
  };

  /**
   * 显示预览窗口，展示首次出现位置的截图
   */
  private static showPreviewPopup(mouseX: number, mouseY: number): void {
    try {
      if (!this.currentFirstMatch) return;

      const { pageIdx, app } = this.currentFirstMatch;
      const pdfViewer = app?.pdfViewer;
      if (!pdfViewer) return;

      const pageView = pdfViewer.getPageView?.(pageIdx);
      if (!pageView) return;

      // 获取页面画布以创建预览
      const canvas = pageView.canvas as HTMLCanvasElement;
      if (!canvas) return;

      // 获取文档对象
      const doc = canvas.ownerDocument;
      if (!doc) return;

      // 移除旧的预览窗口
      this.hidePreviewPopup();

      // 创建预览容器
      const popup = doc.createElement("div");
      popup.id = "zvh-preview-popup";
      popup.style.cssText = `
        position: fixed;
        z-index: 10000;
        width: ${this.PREVIEW_POPUP_WIDTH}px;
        height: ${this.PREVIEW_POPUP_HEIGHT}px;
        background: white;
        border: 2px solid #333;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        overflow: hidden;
        pointer-events: none;
      `;

      // 计算位置（确保不超出视口）
      const viewportWidth = doc.documentElement?.clientWidth ?? 0;
      const viewportHeight = doc.documentElement?.clientHeight ?? 0;

      let left = mouseX + 15;
      let top = mouseY + 15;

      if (left + this.PREVIEW_POPUP_WIDTH > viewportWidth) {
        left = mouseX - this.PREVIEW_POPUP_WIDTH - 15;
      }
      if (top + this.PREVIEW_POPUP_HEIGHT > viewportHeight) {
        top = mouseY - this.PREVIEW_POPUP_HEIGHT - 15;
      }

      popup.style.left = `${Math.max(0, left)}px`;
      popup.style.top = `${Math.max(0, top)}px`;

      // 创建预览图像
      try {
        // 尝试从页面画布创建缩略图
        const previewCanvas = doc.createElement("canvas");
        const ctx = previewCanvas.getContext(
          "2d",
        ) as CanvasRenderingContext2D | null;
        if (ctx && canvas.width > 0 && canvas.height > 0) {
          // 计算缩放比例
          const scale = Math.min(
            this.PREVIEW_POPUP_WIDTH / canvas.width,
            this.PREVIEW_POPUP_HEIGHT / canvas.height,
          );

          previewCanvas.width = this.PREVIEW_POPUP_WIDTH;
          previewCanvas.height = this.PREVIEW_POPUP_HEIGHT;

          // 绘制缩放后的画布
          ctx.fillStyle = "#f5f5f5";
          ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

          const scaledWidth = canvas.width * scale;
          const scaledHeight = canvas.height * scale;
          const offsetX = (this.PREVIEW_POPUP_WIDTH - scaledWidth) / 2;
          const offsetY = (this.PREVIEW_POPUP_HEIGHT - scaledHeight) / 2;

          ctx.drawImage(canvas, offsetX, offsetY, scaledWidth, scaledHeight);

          previewCanvas.style.cssText = "width: 100%; height: 100%;";
          popup.appendChild(previewCanvas);
        }
      } catch (canvasError) {
        this.log(`Canvas preview error: ${canvasError}`);
      }

      // 添加标题
      const title = doc.createElement("div");
      title.style.cssText = `
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 4px 8px;
        font-size: 12px;
        text-align: center;
      `;
      title.textContent = `Definition Location (Page ${pageIdx + 1})`;
      popup.appendChild(title);

      // 添加到文档
      doc.body?.appendChild(popup);
      this.previewPopup = popup;
    } catch (e) {
      this.log(`showPreviewPopup failed: ${String(e)}`);
    }
  }

  /**
   * 隐藏预览窗口
   */
  private static hidePreviewPopup(): void {
    try {
      if (this.previewPopup) {
        this.previewPopup.remove();
        this.previewPopup = null;
      }
    } catch (e) {
      this.log(`hidePreviewPopup failed: ${String(e)}`);
    }
  }
}
