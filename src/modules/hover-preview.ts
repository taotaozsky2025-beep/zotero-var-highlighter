import { hexToRgba, readPrefSafe } from "../utils/colors";

type Reader = any;

const DEFAULT_HOVER_FIRST_COLOR = "#00c369";
const DEFAULT_HOVER_FIRST_OPACITY = 55;
const DEFAULT_HOVER_OTHER_COLOR = "#ff9e00";
const DEFAULT_HOVER_OTHER_OPACITY = 45;
const DEFAULT_HOVER_DELAY_MS = 350;
const DEFAULT_PREVIEW_MAX_WIDTH = 800;
const DEFAULT_PREVIEW_MAX_HEIGHT = 500;
const DEFAULT_VERTICAL_FOCUS_RATIO_PCT = 40;

export interface PreviewContext {
  query: string;
  pageIdx: number;
  matchOffset?: { index: number; length: number };
}

interface ReaderState {
  reader: Reader;
  ctx: PreviewContext;
  innerDoc: Document;
  innerWin: any;
  outerWin: any;
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
  private static readonly TAG = "ZVH-hover-preview-2026-05-08-r2";

  private static get DEBUG_POPUP(): boolean {
    return readPrefSafe<boolean>("developerMode", false);
  }
  private static readonly POPUP_THROTTLE_MS = 0;

  private static get HOVER_DELAY_MS(): number {
    const v = Number(readPrefSafe("hoverDelayMs", DEFAULT_HOVER_DELAY_MS));
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_HOVER_DELAY_MS;
  }
  private static readonly REENTRY_GRACE_MS = 120;
  private static get POPUP_MAX_WIDTH_PX(): number {
    const v = Number(
      readPrefSafe("previewMaxWidth", DEFAULT_PREVIEW_MAX_WIDTH),
    );
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_PREVIEW_MAX_WIDTH;
  }
  private static get POPUP_MAX_HEIGHT_PX(): number {
    const v = Number(
      readPrefSafe("previewMaxHeight", DEFAULT_PREVIEW_MAX_HEIGHT),
    );
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_PREVIEW_MAX_HEIGHT;
  }
  private static readonly POPUP_MIN_WIDTH_PX = 280;
  // 纵向裁切策略：以 first match 为中心向上/下扩展。
  // pref 用 0-100（百分比），运行时除以 100 转成 0..1。
  private static get VERTICAL_FOCUS_RATIO(): number {
    const pct = Number(
      readPrefSafe("verticalFocusRatio", DEFAULT_VERTICAL_FOCUS_RATIO_PCT),
    );
    if (!Number.isFinite(pct)) return DEFAULT_VERTICAL_FOCUS_RATIO_PCT / 100;
    return Math.max(0, Math.min(100, pct)) / 100;
  }
  private static readonly STYLE_ATTR = "data-zvh-hover-preview-style";

  private static readonly FIRST_MARK_CLASS = "zvh-global-first-match";

  private static getHoverFirstRgba(): string {
    return hexToRgba(
      readPrefSafe<string>("hoverFirstColor", DEFAULT_HOVER_FIRST_COLOR),
      Number(readPrefSafe("hoverFirstOpacity", DEFAULT_HOVER_FIRST_OPACITY)),
    );
  }
  private static getHoverOtherRgba(): string {
    return hexToRgba(
      readPrefSafe<string>("hoverOtherColor", DEFAULT_HOVER_OTHER_COLOR),
      Number(readPrefSafe("hoverOtherOpacity", DEFAULT_HOVER_OTHER_OPACITY)),
    );
  }

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
   * 同 (query, pageIdx) → 仅 hide popup 后复用 state；变了 → 销毁旧 state 重建。
   */
  // 冷启动重试参数：第一次选词后内层 doc 可能尚未挂上，
  // 此时 setupForReader 返回 null。重试 5 次 × 200ms 覆盖到 ~1s，
  // 与 ensureReaderWarm 的兜底 timeout 留有重叠余量。
  private static readonly SETUP_RETRY_ATTEMPTS = 5;
  private static readonly SETUP_RETRY_INTERVAL_MS = 200;

  public static onFindCommitted(reader: Reader, ctx: PreviewContext) {
    if (!this.activated || !reader || !ctx) return;
    this.tryCommitWithRetry(reader, ctx, 0);
  }

  private static tryCommitWithRetry(
    reader: Reader,
    ctx: PreviewContext,
    attempt: number,
  ) {
    try {
      const existing = this.states.get(reader);
      if (existing) {
        const same =
          existing.ctx.query === ctx.query &&
          existing.ctx.pageIdx === ctx.pageIdx;
        if (same) {
          existing.ctx = ctx;
          this.hidePopupNow(existing);
          return;
        }
        // query 或 pageIdx 变了 —— 旧的 inner doc/listener 可能已对应失效的搜索状态，干净重建
        this.tearDown(reader);
      }

      const state = this.setupForReader(reader, ctx);
      if (state) {
        this.states.set(reader, state);
        this.popup(
          "onFindCommitted setup",
          `query="${ctx.query}" page=${ctx.pageIdx + 1} attempt=${attempt}`,
          1800,
        );
        return;
      }

      // 冷启动：内层 doc/window 还未就绪，延迟再试。后续 polling reapply
      // 也会再次触发本入口，所以只要这里能在前几次重试中命中即可。
      if (attempt < this.SETUP_RETRY_ATTEMPTS) {
        setTimeout(
          () => this.tryCommitWithRetry(reader, ctx, attempt + 1),
          this.SETUP_RETRY_INTERVAL_MS,
        );
      } else {
        this.popup(
          "onFindCommitted give up",
          `setupForReader returned null after ${attempt} retries`,
          2400,
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
      const outerWin = reader?._iframeWindow;
      if (!outerWin) {
        this.popup("setup return", "no _iframeWindow", 2200);
        return null;
      }

      const app = this.getAppFromOuter(outerWin);
      if (!app) {
        this.popup("setup return", "no PDFViewerApplication", 2200);
        return null;
      }

      const innerDoc = this.getPdfInnerDoc(app, reader);
      if (!innerDoc || !innerDoc.body) {
        this.popup("setup return", "no inner pdfjs doc/body", 2200);
        return null;
      }
      const innerWin = innerDoc.defaultView;
      if (!innerWin) {
        this.popup("setup return", "no inner doc.defaultView", 2200);
        return null;
      }

      this.injectStyle(innerDoc);

      const popupEl = innerDoc.createElement("div");
      popupEl.className = "zvh-hover-preview";
      popupEl.setAttribute("hidden", "");

      const popupHeader = innerDoc.createElement("div");
      popupHeader.className = "zvh-hp-header";
      popupHeader.textContent = "";

      const popupCanvas = innerDoc.createElement("canvas");
      popupCanvas.className = "zvh-hp-canvas";

      popupEl.appendChild(popupHeader);
      popupEl.appendChild(popupCanvas);
      innerDoc.body.appendChild(popupEl);

      const state: ReaderState = {
        reader,
        ctx,
        innerDoc,
        innerWin,
        outerWin,
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
    // 注意：min-width / max-width 不在这里写死，改为 showPopup 时按 pref 内联设置，
    // 这样用户改 previewMaxWidth 立即生效，不需重启 reader。
    style.textContent = `
.zvh-hover-preview {
  position: fixed;
  z-index: 999999;
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
  background: #fafafa;
}
`;
    const host = doc.head ?? doc.documentElement;
    if (host) host.appendChild(style);
  }

  private static attachListeners(state: ReaderState) {
    const { innerDoc, innerWin, outerWin, popupEl } = state;

    const onMouseOver = (e: MouseEvent) => this.onMouseOver(state, e);
    const onMouseOut = (e: MouseEvent) => this.onMouseOut(state, e);
    const onScrollOrResize = () => this.hidePopupNow(state);
    const onUnload = () => this.tearDown(state.reader);

    innerDoc.addEventListener("mouseover", onMouseOver, true);
    innerDoc.addEventListener("mouseout", onMouseOut, true);

    const popupEnter = () => {
      if (state.pendingHideTimer != null) {
        try {
          state.innerWin.clearTimeout(state.pendingHideTimer);
        } catch {
          /* ignore */
        }
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
      try {
        container.addEventListener("scroll", onScrollOrResize, {
          passive: true,
        });
      } catch {
        /* ignore */
      }
    }

    try {
      innerWin.addEventListener("resize", onScrollOrResize);
    } catch {
      /* ignore */
    }

    try {
      innerWin.addEventListener("unload", onUnload);
    } catch {
      /* ignore */
    }
    try {
      outerWin?.addEventListener?.("unload", onUnload);
    } catch {
      /* ignore */
    }

    state.unloadCleanup.push(() => {
      try {
        innerDoc.removeEventListener("mouseover", onMouseOver, true);
      } catch {
        /* ignore */
      }
      try {
        innerDoc.removeEventListener("mouseout", onMouseOut, true);
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
        container?.removeEventListener("scroll", onScrollOrResize);
      } catch {
        /* ignore */
      }
      try {
        innerWin.removeEventListener("resize", onScrollOrResize);
      } catch {
        /* ignore */
      }
      try {
        innerWin.removeEventListener("unload", onUnload);
      } catch {
        /* ignore */
      }
      try {
        outerWin?.removeEventListener?.("unload", onUnload);
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
      // 排除 PDF.js 当前匹配（绿色）和我们自己标的全文首匹配 —— 都指向首处，无需预览
      if (hl.classList.contains("selected")) return;
      if (hl.classList.contains(this.FIRST_MARK_CLASS)) return;
      if (state.hoverTarget === hl) return;
      state.hoverTarget = hl;

      if (state.pendingHideTimer != null) {
        try {
          state.innerWin.clearTimeout(state.pendingHideTimer);
        } catch {
          /* ignore */
        }
        state.pendingHideTimer = null;
      }
      if (state.popupVisible) return;

      if (state.pendingShowTimer != null) {
        try {
          state.innerWin.clearTimeout(state.pendingShowTimer);
        } catch {
          /* ignore */
        }
      }
      const x = e.clientX;
      const y = e.clientY;
      state.pendingShowTimer = state.innerWin.setTimeout(() => {
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
      if (
        newHl &&
        !newHl.classList.contains("selected") &&
        !newHl.classList.contains(this.FIRST_MARK_CLASS)
      ) {
        return;
      }

      state.hoverTarget = null;
      if (state.pendingShowTimer != null) {
        try {
          state.innerWin.clearTimeout(state.pendingShowTimer);
        } catch {
          /* ignore */
        }
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
      try {
        state.innerWin.clearTimeout(state.pendingHideTimer);
      } catch {
        /* ignore */
      }
    }
    try {
      state.pendingHideTimer = state.innerWin.setTimeout(() => {
        state.pendingHideTimer = null;
        this.hidePopupNow(state);
      }, this.REENTRY_GRACE_MS);
    } catch {
      // setTimeout 失败兜底：直接同步隐藏
      this.hidePopupNow(state);
    }
  }

  private static hidePopupNow(state: ReaderState) {
    if (state.pendingShowTimer != null) {
      try {
        state.innerWin.clearTimeout(state.pendingShowTimer);
      } catch {
        /* ignore */
      }
      state.pendingShowTimer = null;
    }
    if (state.pendingHideTimer != null) {
      try {
        state.innerWin.clearTimeout(state.pendingHideTimer);
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
      // innerDoc 可能在异步等待间被释放（reader 关闭、document 重建）
      if (!state.innerDoc?.body || !state.innerDoc.defaultView) {
        this.popup("showPopup skip", "innerDoc gone", 1200);
        return;
      }
      const drew = this.drawPreviewFromViewer(state);
      if (!drew) {
        this.popup("showPopup skip", "page not rendered or no highlight", 1400);
        return;
      }
      // pref 控制的尺寸内联应用，确保改 pref 立即生效
      try {
        state.popupEl.style.minWidth = `${this.POPUP_MIN_WIDTH_PX}px`;
        state.popupEl.style.maxWidth = `${this.POPUP_MAX_WIDTH_PX}px`;
        state.popupEl.style.maxHeight = `${this.POPUP_MAX_HEIGHT_PX}px`;
      } catch {
        /* ignore */
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
   * 复用 PDF.js viewer 已渲染的 page canvas，从中裁切定义所在区域绘到 popup canvas。
   * popup canvas 与 source canvas 同在 inner pdfjs document，drawImage 在同一 realm，安全。
   * 前提：定义页已被 viewer 渲染（一般成立，因为 forceFirstMatch / marker 流程会触发渲染）。
   * 失败返回 false（调用方静默不显示 popup）。
   */
  private static drawPreviewFromViewer(state: ReaderState): boolean {
    try {
      const app = this.getAppFromOuter(state.outerWin);
      if (!app) return false;
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
      if (!isFinite(scale) || scale <= 0) return false;

      const sy = (hlRect.top - tlRect.top) * scale;
      const sh = hlRect.height * scale;

      // 仿 Zotero 原生章节预览：横向取整页宽（不做窄裁切），
      // 纵向以 first match 为中心截出一段，受 popup 最大高度约束。
      const cropX = 0;
      const cropW = sourceCanvas.width;

      // 计算"整页等比缩放后"的高度。如果整页能塞进 max height，就显示整页；
      // 否则按 max height 反推 native 像素尺寸，纵向以 match 为中心裁切。
      const fitScaleByWidth = this.POPUP_MAX_WIDTH_PX / cropW;
      const fullPageDisplayH = sourceCanvas.height * fitScaleByWidth;

      let cropY: number;
      let cropH: number;
      if (fullPageDisplayH <= this.POPUP_MAX_HEIGHT_PX) {
        cropY = 0;
        cropH = sourceCanvas.height;
      } else {
        const cropHNative = this.POPUP_MAX_HEIGHT_PX / fitScaleByWidth;
        const matchCenterY = sy + sh / 2;
        const desiredTop = matchCenterY - cropHNative * this.VERTICAL_FOCUS_RATIO;
        cropY = Math.max(
          0,
          Math.min(sourceCanvas.height - cropHNative, desiredTop),
        );
        cropH = cropHNative;
      }
      // 边界保护
      if (!isFinite(cropY) || cropY < 0) cropY = 0;
      if (!isFinite(cropH) || cropH <= 0) cropH = sourceCanvas.height;
      cropH = Math.min(cropH, sourceCanvas.height - cropY);

      let popupW = Math.max(1, Math.round(cropW * fitScaleByWidth));
      let popupH = Math.max(1, Math.round(cropH * fitScaleByWidth));
      const popupW_drawn = popupW;
      const popupH_drawn = popupH;
      if (popupW < this.POPUP_MIN_WIDTH_PX) {
        popupW = this.POPUP_MIN_WIDTH_PX;
      }

      const popupCanvas = state.popupCanvas;
      popupCanvas.width = popupW;
      popupCanvas.height = popupH;

      const ctx2d = popupCanvas.getContext(
        "2d",
      ) as CanvasRenderingContext2D | null;
      if (!ctx2d) return false;

      ctx2d.fillStyle = "#fafafa";
      ctx2d.fillRect(0, 0, popupW, popupH);
      const offsetX = Math.max(0, Math.round((popupW - popupW_drawn) / 2));
      try {
        ctx2d.drawImage(
          sourceCanvas,
          cropX,
          cropY,
          cropW,
          cropH,
          offsetX,
          0,
          popupW_drawn,
          popupH_drawn,
        );
      } catch (e) {
        this.log(`drawImage failed: ${String(e)}`);
        return false;
      }

      // 叠绘高亮色块
      try {
        const scaleX = popupW_drawn / cropW;
        const scaleY = popupH_drawn / cropH;
        const allHl = textLayerDiv.querySelectorAll(".highlight");
        for (const span of Array.from(allHl)) {
          const el = span as HTMLElement;
          const r = el.getBoundingClientRect();
          const nx = (r.left - tlRect.left) * scale;
          const ny = (r.top - tlRect.top) * scale;
          const nw = r.width * scale;
          const nh = r.height * scale;
          const px = offsetX + nx * scaleX;
          const py = (ny - cropY) * scaleY;
          const pw = nw * scaleX;
          const ph = nh * scaleY;
          // 跳过完全在裁切区域外的
          if (py + ph <= 0 || py >= popupH_drawn) continue;
          const isFirst =
            el.classList.contains("selected") ||
            el.classList.contains(this.FIRST_MARK_CLASS);
          ctx2d.fillStyle = isFirst
            ? this.getHoverFirstRgba()
            : this.getHoverOtherRgba();
          ctx2d.fillRect(px, py, pw, ph);
        }
      } catch {
        // 高亮叠绘失败不影响截图显示
      }

      try {
        state.popupHeader.textContent = `Page ${state.ctx.pageIdx + 1} · "${state.ctx.query}"`;
      } catch {
        /* ignore */
      }
      return true;
    } catch (e) {
      this.log(`drawPreviewFromViewer EXCEPTION: ${String(e)}`);
      return false;
    }
  }

  private static positionPopup(
    state: ReaderState,
    mouseX: number,
    mouseY: number,
  ) {
    try {
      const docEl = state.innerDoc.documentElement;
      const viewportW =
        docEl?.clientWidth ?? state.innerWin.innerWidth ?? 800;
      const viewportH =
        docEl?.clientHeight ?? state.innerWin.innerHeight ?? 600;

      const popupW = state.popupEl.offsetWidth || this.POPUP_MAX_WIDTH_PX;
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
    } catch (e) {
      this.log(`positionPopup failed: ${String(e)}`);
    }
  }

  /**
   * 通过 reader._iframeWindow 桥接到 PDFViewerApplication。
   * 注意：这里只用 outer window，因为 PDFViewerApplication 暴露在 outer iframe 上；
   * 真正的 viewer DOM 在内层 iframe，由 getPdfInnerDoc 解析。
   */
  private static getAppFromOuter(outerWin: any): any {
    try {
      const w = outerWin?.wrappedJSObject ?? outerWin ?? null;
      return w?.PDFViewerApplication ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 解析内层 PDF.js viewer document（承载 .textLayer / .highlight / page canvas）。
   * 与 highlighter.ts:375-406 getPdfDoc 同等链路。
   */
  private static getPdfInnerDoc(app: any, reader: Reader): Document | null {
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
    return reader?._iframeWindow?.document ?? null;
  }

  private static getScrollContainer(state: ReaderState): HTMLElement | null {
    try {
      const app = this.getAppFromOuter(state.outerWin);
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
