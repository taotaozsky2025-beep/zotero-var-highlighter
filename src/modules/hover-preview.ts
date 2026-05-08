type Reader = any;

export interface PreviewContext {
  query: string;
  pageIdx: number;
  matchOffset?: { index: number; length: number };
}

interface ReaderState {
  reader: Reader;
  ctx: PreviewContext;
  iframeWin: any;
  iframeDoc: Document;
  popupEl: HTMLDivElement;
  popupCanvas: HTMLCanvasElement;
  popupHeader: HTMLDivElement;
  pendingShowTimer: number | null;
  pendingHideTimer: number | null;
  popupVisible: boolean;
  hoverTarget: Element | null;
  unloadCleanup: Array<() => void>;
}

export class HoverPreview {
  private static readonly TAG = "ZVH-hover-preview-2026-05-07-r1";

  private static readonly DEBUG_POPUP = false;
  private static readonly POPUP_THROTTLE_MS = 0;

  private static readonly HOVER_DELAY_MS = 350;
  private static readonly REENTRY_GRACE_MS = 120;
  private static readonly POPUP_WIDTH_PX = 360;
  private static readonly POPUP_MAX_HEIGHT_PX = 220;
  private static readonly CROP_PAD_TOP_PX = 40;
  private static readonly CROP_PAD_BOTTOM_PX = 80;
  private static readonly CROP_PAD_X_PX = 24;
  private static readonly STYLE_ATTR = "data-zvh-hover-preview-style";

  private static debugSeq = 0;
  private static lastPopupAt = 0;

  private static states = new Map<Reader, ReaderState>();
  private static activated = false;

  private static log(msg: string) {
    try {
      Zotero.debug(`[zotero-var-highlighter:hover] ${msg}`);
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
    const headline = `ZVH-Hover Step ${seq}: ${step}`;
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

  public static activate(_addon: any) {
    this.activated = true;
    this.popup("activate()", `tag=${this.TAG}`);
  }

  public static deactivate() {
    this.popup("deactivate()", `states=${this.states.size}`);
    for (const reader of Array.from(this.states.keys())) {
      this.tearDown(reader);
    }
    this.states.clear();
    this.activated = false;
  }

  /**
   * 由 Highlighter 在 find 稳定（或每次 firstPageIdx 变化）时回调。
   * 幂等：相同 (query, pageIdx) 不重建监听器/popup。
   */
  public static onFindCommitted(reader: Reader, ctx: PreviewContext) {
    if (!this.activated || !reader || !ctx) return;

    try {
      const existing = this.states.get(reader);
      if (existing) {
        const same =
          existing.ctx.query === ctx.query &&
          existing.ctx.pageIdx === ctx.pageIdx;
        existing.ctx = ctx;
        if (!same) {
          this.hidePopupNow(existing);
        }
        return;
      }

      const state = this.setupForReader(reader, ctx);
      if (state) {
        this.states.set(reader, state);
        this.popup(
          "onFindCommitted setup",
          `query="${ctx.query}" page=${ctx.pageIdx + 1}`,
          1800,
        );
      }
    } catch (e) {
      this.log(`onFindCommitted EXCEPTION: ${String(e)}`);
    }
  }

  /**
   * 由 Highlighter 在新选中开始或清理时调用。
   * 仅隐藏当前 popup；保留监听器/元素以备同 reader 后续 onFindCommitted。
   */
  public static onFindCleared(reader: Reader) {
    const state = this.states.get(reader);
    if (!state) return;
    this.hidePopupNow(state);
  }

  private static setupForReader(
    reader: Reader,
    ctx: PreviewContext,
  ): ReaderState | null {
    try {
      const iframeWin = reader?._iframeWindow;
      if (!iframeWin) {
        this.popup("setup return", "no _iframeWindow", 2200);
        return null;
      }
      const iframeDoc: Document = iframeWin.document;
      if (!iframeDoc || !iframeDoc.body) {
        this.popup("setup return", "no iframe document/body", 2200);
        return null;
      }

      this.injectStyle(iframeDoc);

      const popupEl = iframeDoc.createElement("div");
      popupEl.className = "zvh-hover-preview";
      popupEl.setAttribute("hidden", "");

      const popupHeader = iframeDoc.createElement("div");
      popupHeader.className = "zvh-hp-header";
      popupHeader.textContent = "";

      const popupCanvas = iframeDoc.createElement("canvas");
      popupCanvas.className = "zvh-hp-canvas";

      popupEl.appendChild(popupHeader);
      popupEl.appendChild(popupCanvas);
      iframeDoc.body.appendChild(popupEl);

      const state: ReaderState = {
        reader,
        ctx,
        iframeWin,
        iframeDoc,
        popupEl,
        popupCanvas,
        popupHeader,
        pendingShowTimer: null,
        pendingHideTimer: null,
        popupVisible: false,
        hoverTarget: null,
        unloadCleanup: [],
      };

      this.attachListeners(state);
      return state;
    } catch (e) {
      this.log(`setupForReader failed: ${String(e)}`);
      return null;
    }
  }

  private static injectStyle(doc: Document) {
    if (doc.head?.querySelector(`style[${this.STYLE_ATTR}]`)) return;
    const style = doc.createElement("style");
    style.setAttribute(this.STYLE_ATTR, "1");
    style.textContent = `
.zvh-hover-preview {
  position: fixed;
  z-index: 999999;
  width: ${this.POPUP_WIDTH_PX}px;
  max-height: ${this.POPUP_MAX_HEIGHT_PX}px;
  background: #ffffff;
  border: 1px solid rgba(0,0,0,0.18);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.18);
  overflow: hidden;
  pointer-events: auto;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 12px;
  color: #333;
}
.zvh-hover-preview[hidden] { display: none !important; }
.zvh-hp-header {
  padding: 4px 8px;
  background: #f3f3f3;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  font-size: 11px;
  color: #666;
}
.zvh-hp-canvas {
  display: block;
  width: 100%;
  height: auto;
  background: #fafafa;
}
`;
    const host = doc.head ?? doc.documentElement;
    if (host) host.appendChild(style);
  }

  private static attachListeners(state: ReaderState) {
    const { iframeDoc, iframeWin, popupEl } = state;

    const onMouseOver = (e: MouseEvent) => this.onMouseOver(state, e);
    const onMouseOut = (e: MouseEvent) => this.onMouseOut(state, e);
    const onScrollOrZoom = () => this.hidePopupNow(state);
    const onUnload = () => this.tearDown(state.reader);

    iframeDoc.addEventListener("mouseover", onMouseOver, true);
    iframeDoc.addEventListener("mouseout", onMouseOut, true);

    const popupEnter = () => {
      if (state.pendingHideTimer != null) {
        iframeWin.clearTimeout(state.pendingHideTimer);
        state.pendingHideTimer = null;
      }
    };
    const popupLeave = () => {
      this.scheduleHide(state);
    };
    popupEl.addEventListener("mouseenter", popupEnter);
    popupEl.addEventListener("mouseleave", popupLeave);

    const container = this.getScrollContainer(state);
    if (container) {
      container.addEventListener("scroll", onScrollOrZoom, { passive: true });
    }

    let scaleHandler: ((d: any) => void) | null = null;
    try {
      const app = this.getApp(state);
      const eb = app?.eventBus;
      if (eb && typeof eb.on === "function") {
        scaleHandler = (_d: any) => onScrollOrZoom();
        eb.on("scalechanged", scaleHandler);
      }
    } catch {
      /* ignore */
    }

    iframeWin.addEventListener("unload", onUnload);

    state.unloadCleanup.push(() => {
      try {
        iframeDoc.removeEventListener("mouseover", onMouseOver, true);
      } catch {
        /* ignore */
      }
      try {
        iframeDoc.removeEventListener("mouseout", onMouseOut, true);
      } catch {
        /* ignore */
      }
      try {
        popupEl.removeEventListener("mouseenter", popupEnter);
      } catch {
        /* ignore */
      }
      try {
        popupEl.removeEventListener("mouseleave", popupLeave);
      } catch {
        /* ignore */
      }
      try {
        container?.removeEventListener("scroll", onScrollOrZoom);
      } catch {
        /* ignore */
      }
      try {
        const app = this.getApp(state);
        const eb = app?.eventBus;
        if (scaleHandler && eb && typeof eb.off === "function") {
          eb.off("scalechanged", scaleHandler);
        }
      } catch {
        /* ignore */
      }
      try {
        iframeWin.removeEventListener("unload", onUnload);
      } catch {
        /* ignore */
      }
      try {
        popupEl.remove();
      } catch {
        /* ignore */
      }
    });
  }

  private static onMouseOver(state: ReaderState, e: MouseEvent) {
    try {
      const target = e.target as Element | null;
      if (!target || !target.closest) return;
      const hl = target.closest(".textLayer .highlight") as Element | null;
      if (!hl) return;
      if (hl.classList.contains("selected")) return;
      if (state.hoverTarget === hl) return;
      state.hoverTarget = hl;

      if (state.pendingHideTimer != null) {
        state.iframeWin.clearTimeout(state.pendingHideTimer);
        state.pendingHideTimer = null;
      }
      if (state.popupVisible) return;

      if (state.pendingShowTimer != null) {
        state.iframeWin.clearTimeout(state.pendingShowTimer);
      }
      const x = e.clientX;
      const y = e.clientY;
      state.pendingShowTimer = state.iframeWin.setTimeout(() => {
        state.pendingShowTimer = null;
        void this.showPopup(state, x, y);
      }, this.HOVER_DELAY_MS);
    } catch (err) {
      this.log(`onMouseOver failed: ${String(err)}`);
    }
  }

  private static onMouseOut(state: ReaderState, e: MouseEvent) {
    try {
      const target = e.target as Element | null;
      if (!target || !target.closest) return;
      const hl = target.closest(".textLayer .highlight") as Element | null;
      if (!hl) return;
      const related = e.relatedTarget as Element | null;
      const newHl = related?.closest?.(
        ".textLayer .highlight",
      ) as Element | null;
      if (newHl && !newHl.classList.contains("selected")) return;

      state.hoverTarget = null;
      if (state.pendingShowTimer != null) {
        state.iframeWin.clearTimeout(state.pendingShowTimer);
        state.pendingShowTimer = null;
      }
      if (state.popupVisible) {
        this.scheduleHide(state);
      }
    } catch (err) {
      this.log(`onMouseOut failed: ${String(err)}`);
    }
  }

  private static scheduleHide(state: ReaderState) {
    if (state.pendingHideTimer != null) {
      state.iframeWin.clearTimeout(state.pendingHideTimer);
    }
    state.pendingHideTimer = state.iframeWin.setTimeout(() => {
      state.pendingHideTimer = null;
      this.hidePopupNow(state);
    }, this.REENTRY_GRACE_MS);
  }

  private static hidePopupNow(state: ReaderState) {
    if (state.pendingShowTimer != null) {
      try {
        state.iframeWin.clearTimeout(state.pendingShowTimer);
      } catch {
        /* ignore */
      }
      state.pendingShowTimer = null;
    }
    if (state.pendingHideTimer != null) {
      try {
        state.iframeWin.clearTimeout(state.pendingHideTimer);
      } catch {
        /* ignore */
      }
      state.pendingHideTimer = null;
    }
    state.hoverTarget = null;
    state.popupVisible = false;
    try {
      state.popupEl.setAttribute("hidden", "");
    } catch {
      /* ignore */
    }
  }

  private static async showPopup(
    state: ReaderState,
    mouseX: number,
    mouseY: number,
  ) {
    try {
      const drew = this.drawPreviewFromViewer(state);
      if (!drew) {
        this.popup("showPopup skip", "page not rendered or no highlight", 1400);
        return;
      }
      this.positionPopup(state, mouseX, mouseY);
      state.popupEl.removeAttribute("hidden");
      state.popupVisible = true;
      this.popup("showPopup OK", `page=${state.ctx.pageIdx + 1}`, 1200);
    } catch (e) {
      this.log(`showPopup failed: ${String(e)}`);
    }
  }

  /**
   * 直接复用 PDF.js viewer 已渲染的 page canvas，从中裁切定义所在区域绘到 popup canvas。
   * 前提：定义页已被 viewer 渲染过（一般成立，因为 forceGlobalFirstAsCurrentMatch 会触发渲染）。
   * 失败返回 false（调用方静默不显示 popup，不降级到文本）。
   */
  private static drawPreviewFromViewer(state: ReaderState): boolean {
    const app = this.getApp(state);
    const pageView = app?.pdfViewer?._pages?.[state.ctx.pageIdx];
    if (!pageView) return false;

    const sourceCanvas: HTMLCanvasElement | null = pageView.canvas ?? null;
    const textLayerDiv: HTMLElement | null =
      pageView.textLayer?.div ?? pageView.textLayer?.textLayerDiv ?? null;
    if (!sourceCanvas || !textLayerDiv) return false;

    const firstHl = textLayerDiv.querySelector(
      ".highlight",
    ) as HTMLElement | null;
    if (!firstHl) return false;

    const tlRect = textLayerDiv.getBoundingClientRect();
    const hlRect = firstHl.getBoundingClientRect();
    if (tlRect.width <= 0 || tlRect.height <= 0) return false;

    const scale = sourceCanvas.width / tlRect.width;
    const sx = (hlRect.left - tlRect.left) * scale;
    const sy = (hlRect.top - tlRect.top) * scale;
    const sw = hlRect.width * scale;
    const sh = hlRect.height * scale;

    const padTop = this.CROP_PAD_TOP_PX * scale;
    const padBottom = this.CROP_PAD_BOTTOM_PX * scale;
    const padX = this.CROP_PAD_X_PX * scale;

    const cropX = Math.max(0, sx - padX);
    const cropY = Math.max(0, sy - padTop);
    let cropW = Math.min(sourceCanvas.width - cropX, sw + padX * 2);
    let cropH = Math.min(sourceCanvas.height - cropY, sh + padTop + padBottom);
    cropW = Math.max(1, cropW);
    cropH = Math.max(1, cropH);

    const popupW = this.POPUP_WIDTH_PX;
    const drawScale = popupW / cropW;
    const popupH = Math.min(
      this.POPUP_MAX_HEIGHT_PX,
      Math.round(cropH * drawScale),
    );

    const popupCanvas = state.popupCanvas;
    popupCanvas.width = popupW;
    popupCanvas.height = popupH;

    const ctx2d = popupCanvas.getContext(
      "2d",
    ) as CanvasRenderingContext2D | null;
    if (!ctx2d) return false;

    ctx2d.fillStyle = "#fafafa";
    ctx2d.fillRect(0, 0, popupW, popupH);
    try {
      ctx2d.drawImage(
        sourceCanvas,
        cropX,
        cropY,
        cropW,
        cropH,
        0,
        0,
        popupW,
        popupH,
      );
    } catch (e) {
      this.log(`drawImage failed: ${String(e)}`);
      return false;
    }

    state.popupHeader.textContent = `Page ${state.ctx.pageIdx + 1} · "${state.ctx.query}"`;
    return true;
  }

  private static positionPopup(
    state: ReaderState,
    mouseX: number,
    mouseY: number,
  ) {
    const docEl = state.iframeDoc.documentElement;
    const viewportW = docEl?.clientWidth ?? state.iframeWin.innerWidth ?? 800;
    const viewportH = docEl?.clientHeight ?? state.iframeWin.innerHeight ?? 600;

    const popupW = state.popupEl.offsetWidth || this.POPUP_WIDTH_PX;
    const popupH = state.popupEl.offsetHeight || this.POPUP_MAX_HEIGHT_PX;

    let left = mouseX + 16;
    let top = mouseY + 16;

    if (left + popupW > viewportW - 8) {
      left = Math.max(8, mouseX - popupW - 16);
    }
    if (top + popupH > viewportH - 8) {
      top = Math.max(8, mouseY - popupH - 16);
    }

    state.popupEl.style.left = `${Math.round(left)}px`;
    state.popupEl.style.top = `${Math.round(top)}px`;
  }

  private static getApp(state: ReaderState): any {
    try {
      const w = state.iframeWin?.wrappedJSObject ?? state.iframeWin ?? null;
      return w?.PDFViewerApplication ?? null;
    } catch {
      return null;
    }
  }

  private static getScrollContainer(state: ReaderState): HTMLElement | null {
    try {
      const app = this.getApp(state);
      return (
        app?.pdfViewer?.container ??
        app?.appConfig?.mainContainer ??
        app?.appConfig?.viewerContainer ??
        null
      );
    } catch {
      return null;
    }
  }

  private static tearDown(reader: Reader) {
    const state = this.states.get(reader);
    if (!state) return;
    this.hidePopupNow(state);
    for (const fn of state.unloadCleanup) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    state.unloadCleanup.length = 0;
    this.states.delete(reader);
    this.popup("tearDown", `states=${this.states.size}`, 1200);
  }
}
