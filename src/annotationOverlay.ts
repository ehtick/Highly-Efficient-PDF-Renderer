import type { SceneAnnotation } from "./annotationData";
import type { VectorScene } from "./pdfVectorExtractor";
import { createDefaultOptionalContentSnapshot, type OptionalContentSnapshot } from "./optionalContent";

export interface AnnotationPoint { x: number; y: number }
export interface AnnotationOverlayAdapter {
  getScene(): VectorScene | null;
  getOptionalContentVisibility?(): OptionalContentSnapshot | null;
  clientToScenePoint(clientX: number, clientY: number): AnnotationPoint | null;
  sceneToClientPoint(sceneX: number, sceneY: number): AnnotationPoint | null;
  /** For example, while drawing selection is enabled or a text selection is active. */
  isInteractionSuppressed?(): boolean;
}
export interface AnnotationOverlayOptions {
  getCanvas(): HTMLCanvasElement | null;
  adapter: AnnotationOverlayAdapter;
  enabled?: boolean;
  /** Replace only the bubble body. The host retains pinning, positioning and dismissal. */
  renderContent?(annotation: SceneAnnotation, container: HTMLElement): void;
}
export interface AnnotationOverlay {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  /** Open a scene annotation programmatically, for example from an accessible list. */
  show(annotation: SceneAnnotation): void;
  hide(): void;
  /** Call after camera, layer or backend updates; there is no internal animation loop. */
  onFrame(): void;
  /** Resets only when the scene identity changes; backend switches keep pinned bubbles. */
  sceneChanged(): void;
  dispose(): void;
}

const defaultVisibility = new WeakMap<VectorScene, OptionalContentSnapshot>();
function visible(annotation: SceneAnnotation, scene: VectorScene, snapshot?: OptionalContentSnapshot | null): boolean {
  if (annotation.subtype === "Popup" || (annotation.flags & (1 | 2 | 32)) !== 0) return false;
  if (annotation.optionalContent === undefined) return annotation.visibleInDefaultView;
  let visibility = snapshot;
  if (!visibility) {
    visibility = defaultVisibility.get(scene);
    if (!visibility) { visibility = createDefaultOptionalContentSnapshot(scene); defaultVisibility.set(scene, visibility); }
  }
  return visibility.conditions[annotation.optionalContent] !== 0 && visibility.conditions[annotation.optionalContent] !== undefined;
}

function insidePage(scene: VectorScene, page: number, p: AnnotationPoint): boolean {
  const offset = page * 4, rects = scene.pageRects;
  return p.x >= rects[offset] && p.y >= rects[offset + 1] && p.x <= rects[offset + 2] && p.y <= rects[offset + 3];
}

function polygonContains(values: readonly number[], offset: number, point: AnnotationPoint): boolean {
  const points = Array.from({ length: 4 }, (_, i) => ({ x: values[offset + i * 2], y: values[offset + i * 2 + 1] }));
  const cx = points.reduce((sum, p) => sum + p.x, 0) / 4, cy = points.reduce((sum, p) => sum + p.y, 0) / 4;
  points.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let positive = false, negative = false;
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    positive ||= cross > 1e-8; negative ||= cross < -1e-8;
  }
  return !(positive && negative) && (positive || negative);
}

function segmentDistance(p: AnnotationPoint, a: AnnotationPoint, b: AnnotationPoint): number {
  const x = b.x - a.x, y = b.y - a.y, length = x * x + y * y;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / length)) : 0;
  return Math.hypot(p.x - a.x - t * x, p.y - a.y - t * y);
}

/** Metadata-only hit testing; no GPU picking and no DOM elements per annotation. */
export function pickSceneAnnotation(scene: VectorScene, clientX: number, clientY: number,
  adapter: AnnotationOverlayAdapter): SceneAnnotation | null {
  const point = adapter.clientToScenePoint(clientX, clientY);
  if (!point) return null;
  const snapshot = adapter.getOptionalContentVisibility?.();
  let best: SceneAnnotation | null = null, bestArea = Infinity;
  for (const a of scene.annotations ?? []) {
    if (!visible(a, scene, snapshot) || !insidePage(scene, a.pageIndex, point)) continue;
    const b = a.bounds;
    let hit = false, area = (b.maxX - b.minX) * (b.maxY - b.minY);
    if (a.quadPoints?.length) {
      for (let i = 0; i < a.quadPoints.length; i += 8) if (polygonContains(a.quadPoints, i, point)) {
        hit = true;
        const q = a.quadPoints;
        area = Math.min(area, (Math.max(q[i], q[i + 2], q[i + 4], q[i + 6]) - Math.min(q[i], q[i + 2], q[i + 4], q[i + 6])) *
          (Math.max(q[i + 1], q[i + 3], q[i + 5], q[i + 7]) - Math.min(q[i + 1], q[i + 3], q[i + 5], q[i + 7])));
      }
    } else if (a.inkList?.length) {
      const rect = a.pdfGeometry.rect;
      const sourceArea = Math.abs((rect[2] - rect[0]) * (rect[3] - rect[1]));
      const unitScale = sourceArea > 0 ? Math.sqrt(area / sourceArea) : 1;
      const radius = (a.border?.width ?? 1) * unitScale / 2;
      for (const path of a.inkList) {
        for (let i = 0; i < path.length; i += 2) {
          const start = adapter.sceneToClientPoint(path[i], path[i + 1]);
          const end = adapter.sceneToClientPoint(path[Math.min(i + 2, path.length - 2)], path[Math.min(i + 3, path.length - 1)]);
          if (!start || !end) continue;
          const edgeX = adapter.sceneToClientPoint(path[i] + radius, path[i + 1]);
          const edgeY = adapter.sceneToClientPoint(path[i], path[i + 1] + radius);
          const strokeRadius = Math.max(edgeX ? Math.hypot(edgeX.x - start.x, edgeX.y - start.y) : 0,
            edgeY ? Math.hypot(edgeY.x - start.x, edgeY.y - start.y) : 0);
          if (segmentDistance({ x: clientX, y: clientY }, start, end) <= 5 + strokeRadius) { hit = true; break; }
        }
        if (hit) break;
      }
    } else hit = point.x >= b.minX && point.x <= b.maxX && point.y >= b.minY && point.y <= b.maxY;
    if (hit && area <= bestArea) {
      best = a; bestArea = area;
    }
  }
  return best;
}

function renderDefaultContent(annotation: SceneAnnotation, container: HTMLElement): void {
  const document = container.ownerDocument;
  const heading = document.createElement("strong");
  heading.textContent = annotation.tooltip || annotation.subject || annotation.field?.name || annotation.subtype;
  container.appendChild(heading);
  if (annotation.contents) {
    const body = document.createElement("div");
    body.style.cssText = "white-space:pre-wrap;margin-top:6px;";
    body.textContent = annotation.contents;
    container.appendChild(body);
  }
  const details = [annotation.author, annotation.modificationDate ?? annotation.creationDate];
  if (annotation.field?.value !== undefined && annotation.field.value !== null && (annotation.field.flags & (1 << 13)) === 0) {
    details.push(String(annotation.field.value));
  }
  if (annotation.action) {
    const action = annotation.action;
    details.push(action.uri ?? action.file ?? action.name ?? action.destination?.name ?? action.type);
  } else if (annotation.destination) details.push(annotation.destination.name ??
    (annotation.destination.sourcePageIndex === undefined ? "Destination" : `Page ${annotation.destination.sourcePageIndex + 1}`));
  const footer = document.createElement("div");
  footer.style.cssText = "white-space:pre-wrap;margin-top:6px;font-size:12px;opacity:.75;";
  footer.textContent = details.filter(Boolean).join("\n");
  container.appendChild(footer);
}

/** Opt-in HTML UI. Importing this module never creates elements or registers listeners. */
export function createAnnotationOverlay(options: AnnotationOverlayOptions): AnnotationOverlay {
  const { adapter } = options;
  const document = options.getCanvas()?.ownerDocument ?? globalThis.document;
  const window = document.defaultView!;
  const panel = document.createElement("div");
  panel.className = "hepr-annotation-bubble";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "PDF annotation");
  panel.style.cssText = "position:fixed;z-index:10001;box-sizing:border-box;max-width:min(360px,calc(100vw - 16px));" +
    "max-height:min(320px,calc(100vh - 16px));overflow:auto;padding:12px 36px 12px 14px;" +
    "border:1px solid #9ca3af;border-radius:8px;background:#fff;color:#111827;" +
    "box-shadow:0 4px 16px #0003;font:14px/1.4 system-ui,sans-serif;overflow-wrap:anywhere;" +
    "user-select:text;-webkit-user-select:text;pointer-events:auto;";
  panel.hidden = true;
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close annotation");
  close.style.cssText = "position:absolute;top:4px;right:5px;border:0;background:transparent;color:inherit;font:22px system-ui;cursor:pointer;";
  const content = document.createElement("div");
  panel.appendChild(close); panel.appendChild(content); document.body.appendChild(panel);
  const lifetime = new AbortController();
  const eventOptions = { capture: true, signal: lifetime.signal };
  let enabled = options.enabled !== false, disposed = false;
  let scene = adapter.getScene(), active: SceneAnnotation | null = null, pinned = false;
  let pointer: AnnotationPoint | null = null;
  let gesture: { id: number; start: AnnotationPoint; time: number; moved: boolean; multiple: boolean } | null = null;
  const pointers = new Set<number>();
  let frame = 0;

  function hide(): void { active = null; pinned = false; panel.hidden = true; }
  function sceneChanged(): void {
    const next = adapter.getScene();
    if (scene !== next) { hide(); pointer = null; gesture = null; pointers.clear(); scene = next; }
  }
  function suppressed(): boolean { return !enabled || disposed || !!adapter.isInteractionSuppressed?.(); }
  function position(): void {
    if (!active || !scene) return;
    if (suppressed() || !visible(active, scene, adapter.getOptionalContentVisibility?.())) { hide(); return; }
    const b = active.bounds, offset = active.pageIndex * 4, rects = scene.pageRects;
    const minX = Math.max(b.minX, rects[offset]), maxX = Math.min(b.maxX, rects[offset + 2]);
    const minY = Math.max(b.minY, rects[offset + 1]), maxY = Math.min(b.maxY, rects[offset + 3]);
    if (minX > maxX || minY > maxY) { hide(); return; }
    const anchor = adapter.sceneToClientPoint((minX + maxX) / 2, maxY);
    const viewport = options.getCanvas()?.getBoundingClientRect();
    if (!anchor || !viewport || anchor.x < viewport.left || anchor.x > viewport.right || anchor.y < viewport.top || anchor.y > viewport.bottom) {
      panel.hidden = true; return;
    }
    panel.hidden = false;
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const x = Math.max(8, Math.min(anchor.x + 12, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(anchor.y + 12, window.innerHeight - height - 8));
    panel.style.left = `${Math.round(x)}px`; panel.style.top = `${Math.round(y)}px`;
  }
  function display(annotation: SceneAnnotation, pin: boolean): void {
    if (active !== annotation) {
      content.replaceChildren();
      (options.renderContent ?? renderDefaultContent)(annotation, content);
    }
    active = annotation; pinned = pin; position();
  }
  function updateHover(): void {
    frame = 0; sceneChanged();
    if (suppressed()) { hide(); return; }
    if (pinned || gesture || !pointer || !scene) return;
    const annotation = pickSceneAnnotation(scene, pointer.x, pointer.y, adapter);
    if (annotation) display(annotation, false); else hide();
  }
  function scheduleHover(): void { if (!frame) frame = window.requestAnimationFrame(updateHover); }
  function onFrame(): void { sceneChanged(); if (active) position(); if (!pinned && pointer && !gesture) scheduleHover(); }
  function insidePanel(event: Event): boolean { return !!event.target && panel.contains(event.target as Node); }

  window.addEventListener("pointerdown", event => {
    sceneChanged();
    if (insidePanel(event)) { pinned = true; return; }
    if (event.target !== options.getCanvas()) { pointer = null; hide(); return; }
    pointers.add(event.pointerId);
    if (gesture) { gesture.multiple = true; return; }
    if (event.button !== 0 || suppressed()) return;
    gesture = { id: event.pointerId, start: { x: event.clientX, y: event.clientY },
      time: performance.now(), moved: false, multiple: pointers.size > 1 };
    if (!pinned) hide();
  }, eventOptions);
  window.addEventListener("pointermove", event => {
    if (gesture) {
      if (event.pointerId === gesture.id && Math.hypot(event.clientX - gesture.start.x, event.clientY - gesture.start.y) > 5) gesture.moved = true;
      return;
    }
    if (insidePanel(event)) return;
    if (event.target !== options.getCanvas() || event.buttons !== 0 || event.pointerType === "touch") {
      pointer = null; if (!pinned) hide(); return;
    }
    pointer = { x: event.clientX, y: event.clientY }; scheduleHover();
  }, eventOptions);
  window.addEventListener("pointerup", event => {
    pointers.delete(event.pointerId);
    if (!gesture || gesture.id !== event.pointerId) return;
    const ended = gesture; gesture = null;
    if (ended.moved || ended.multiple || performance.now() - ended.time > 450 || suppressed()) return;
    sceneChanged();
    if (!scene) return;
    const annotation = pickSceneAnnotation(scene, event.clientX, event.clientY, adapter);
    if (annotation) display(annotation, true); else hide();
  }, eventOptions);
  window.addEventListener("pointercancel", () => { gesture = null; pointers.clear(); pointer = null; if (!pinned) hide(); }, eventOptions);
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && active) { const focused = panel.contains(document.activeElement); pointer = null; hide(); if (focused) options.getCanvas()?.focus(); }
    else if (event.key === "Enter" && event.target === options.getCanvas() && active) { pinned = true; close.focus(); }
  }, eventOptions);
  window.addEventListener("blur", () => { gesture = null; pointers.clear(); pointer = null; if (!pinned) hide(); }, { signal: lifetime.signal });
  window.addEventListener("resize", onFrame, { signal: lifetime.signal });
  window.addEventListener("scroll", onFrame, eventOptions);
  panel.addEventListener("pointerdown", event => event.stopPropagation(), { signal: lifetime.signal });
  close.addEventListener("click", () => { pointer = null; hide(); options.getCanvas()?.focus(); }, { signal: lifetime.signal });
  return {
    enable() { if (!disposed) enabled = true; },
    disable() { enabled = false; hide(); },
    isEnabled: () => enabled && !disposed,
    show(annotation) { sceneChanged(); if (!suppressed() && scene?.annotations?.includes(annotation)) display(annotation, true); },
    hide() { pointer = null; hide(); }, onFrame, sceneChanged,
    dispose() { if (disposed) return; disposed = true; lifetime.abort(); if (frame) window.cancelAnimationFrame(frame); panel.remove(); active = null; }
  };
}
