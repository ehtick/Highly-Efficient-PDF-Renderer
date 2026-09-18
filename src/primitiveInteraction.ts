import type { VectorScene } from "./pdfVectorExtractor";
import type { RendererApi } from "./rendererTypes";
import { PrimitiveAppearanceState, normalizePrimitiveColor, primitiveRefKey, type PrimitiveColorInput } from "./primitiveAppearance";
import { ScenePrimitivePicker, getScenePrimitive, type PrimitiveHit, type PrimitiveInfo, type PrimitivePoint, type PrimitiveRef } from "./scenePrimitives";

export interface PrimitiveInteractionCallbacks {
  onSelectionChange?(primitive: PrimitiveInfo | null, displayColor?: [number, number, number] | null): void;
  onPreparationProgress?(percentage: number | null): void;
  onError?(error: unknown): void;
}

export interface PrimitiveInteractionOptions extends PrimitiveInteractionCallbacks {
  getCanvas(): HTMLCanvasElement;
  getRenderer(): RendererApi;
  getScene(): VectorScene | null;
}

/** Backend operations used by the shared pointer and selection controller. */
export interface PrimitiveInteractionAdapter {
  getCanvas(): HTMLCanvasElement;
  getScene(): VectorScene | null;
  getTarget(): unknown;
  getViewKey(): string;
  pick(point: PrimitivePoint, signal: AbortSignal): Promise<PrimitiveHit | null>;
  setHover(ref: PrimitiveRef | null): void;
  setSelection(refs: readonly PrimitiveRef[]): void;
  setOverrides(refs: readonly PrimitiveRef[], color: PrimitiveColorInput): void;
  clearOverrides(refs?: readonly PrimitiveRef[]): void;
  sceneChanged(onProgress: (percentage: number | null) => void): void;
  rendererChanged(): void;
  dispose(): void;
}

interface PickRequest { point: PrimitivePoint; select: boolean }

/** Shared event handling, request scheduling, and document-scoped selection state. */
export function createPrimitiveInteractionControllerForAdapter(
  adapter: PrimitiveInteractionAdapter, options: PrimitiveInteractionCallbacks
) {
  let enabled = false;
  let canvas: HTMLCanvasElement | null = null;
  let scene: VectorScene | null = null;
  let selected: PrimitiveRef | null = null;
  const colors = new Map<string, { ref: PrimitiveRef; color: [number, number, number] }>();
  let preparationProgress: number | null = null;
  let active: AbortController | null = null;
  let activeRequest: PickRequest | null = null;
  let pending: PickRequest | null = null;
  let frame: number | null = null;
  let revision = 0;
  let pointer: PrimitivePoint | null = null;
  let viewKey = "";
  let selectingGesture = false;
  let sceneRevision = 0;
  const downs = new Map<number, { x: number; y: number; moved: boolean }>();

  function setPreparationProgress(percentage: number | null): void {
    if (preparationProgress === percentage) return;
    preparationProgress = percentage;
    options.onPreparationProgress?.(percentage);
  }

  function setHover(ref: PrimitiveRef | null): void {
    adapter.setHover(ref);
    canvas?.classList.toggle("drawing-selection-hover", ref !== null);
  }

  function notifySelection(): void {
    const primitive = selected && scene ? getScenePrimitive(scene, selected) : null;
    const color = selected ? colors.get(primitiveRefKey(selected))?.color ?? primitive?.color : null;
    options.onSelectionChange?.(primitive, color ? [...color] : null);
  }

  function currentViewKey(): string {
    const element = adapter.getCanvas();
    const rect = element.getBoundingClientRect();
    return `${adapter.getViewKey()}:${element.width}:${element.height}:` +
      `${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
  }

  function pendingSelection(): PickRequest | null {
    if (pending?.select) return pending;
    return active && !active.signal.aborted && activeRequest?.select ? activeRequest : null;
  }

  function cancelQuery(): void {
    revision++;
    pending = null;
    active?.abort();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function resetScene(): void {
    cancelQuery();
    canvas?.classList.remove("drawing-selection-hover");
    downs.clear();
    selectingGesture = false;
    pointer = null;
    setPreparationProgress(null);
    selected = null;
    colors.clear();
    scene = adapter.getScene();
    const source = scene;
    const generation = ++sceneRevision;
    adapter.sceneChanged(percentage => {
      if (enabled && generation === sceneRevision && scene === source && adapter.getScene() === source) {
        setPreparationProgress(percentage);
      }
    });
    options.onSelectionChange?.(null);
    viewKey = currentViewKey();
  }

  function schedule(point: PrimitivePoint, select: boolean): void {
    if (!enabled || !scene) return;
    if (!select && pending?.select) return;
    if (!select && active && !active.signal.aborted && activeRequest?.select) {
      pending = { point, select: false };
      return;
    }
    revision++;
    active?.abort();
    // A queued click takes priority over hover from the same pointer gesture.
    pending = { point, select };
    if (frame === null && !active) frame = requestAnimationFrame(() => { frame = null; void query(); });
  }

  async function query(): Promise<void> {
    if (!enabled || !scene || !pending || active) return;
    const request = pending;
    pending = null;
    const token = revision;
    const source = scene;
    const target = adapter.getTarget();
    const queryViewKey = currentViewKey();
    const controller = new AbortController();
    active = controller;
    activeRequest = request;
    try {
      const hit = await adapter.pick(request.point, controller.signal);
      if (controller.signal.aborted || token !== revision || !enabled || source !== adapter.getScene() || target !== adapter.getTarget()) return;
      if (queryViewKey !== currentViewKey()) {
        schedule(request.point, request.select);
        return;
      }
      // A completed click still selects after the pointer leaves, but must not
      // restore a stale hover trace or cursor at its former position.
      const stillHovering = pointer?.x === request.point.x && pointer?.y === request.point.y;
      setHover(stillHovering ? hit?.primitive ?? null : null);
      if (request.select) {
        selected = hit ? { ...hit.primitive } : null;
        adapter.setSelection(selected ? [selected] : []);
        notifySelection();
        if (pointer && !stillHovering && !pending) pending = { point: pointer, select: false };
      }
    } catch (error) {
      if (!controller.signal.aborted) options.onError?.(error);
    } finally {
      if (active === controller) { active = null; activeRequest = null; }
      if (enabled && pending && frame === null) frame = requestAnimationFrame(() => { frame = null; void query(); });
    }
  }

  const pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType !== "touch") return;
    cancelQuery();
    downs.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false });
    if (downs.size > 1) for (const down of downs.values()) down.moved = true;
    selectingGesture = true;
    setHover(null);
  };
  const pointerMove = (event: PointerEvent): void => {
    pointer = { x: event.clientX, y: event.clientY };
    const down = downs.get(event.pointerId);
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) down.moved = true;
    if (!downs.size && event.buttons === 0 && event.pointerType !== "touch") schedule(pointer, false);
  };
  const pointerUp = (event: PointerEvent): void => {
    const down = downs.get(event.pointerId);
    downs.delete(event.pointerId);
    selectingGesture = downs.size > 0;
    pointer = event.pointerType === "touch" ? null : { x: event.clientX, y: event.clientY };
    if (down && !down.moved && !downs.size && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 4) {
      schedule({ x: event.clientX, y: event.clientY }, true);
    }
  };
  const pointerCancel = (): void => { downs.clear(); selectingGesture = false; cancelQuery(); leave(); };
  const lostPointerCapture = (event: PointerEvent): void => {
    // Normal capture release follows pointerup and must not cancel its queued pick.
    if (downs.has(event.pointerId)) pointerCancel();
  };
  const leave = (): void => {
    pointer = null;
    if (!pendingSelection()) cancelQuery();
    else if (pending && !pending.select) pending = null;
    setHover(null);
  };
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    cancelQuery();
    setHover(null);
    selected = null;
    adapter.setSelection([]);
    options.onSelectionChange?.(null);
  };

  function detach(): void {
    if (!canvas) return;
    canvas.classList.remove("drawing-selection-hover");
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointermove", pointerMove);
    canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("pointercancel", pointerCancel);
    canvas.removeEventListener("lostpointercapture", lostPointerCapture);
    canvas.removeEventListener("pointerleave", leave);
    canvas.ownerDocument.removeEventListener("keydown", keyDown);
    canvas = null;
    downs.clear();
    selectingGesture = false;
  }
  function attach(): void {
    const next = adapter.getCanvas();
    if (canvas === next) return;
    detach();
    canvas = next;
    canvas.classList.remove("drawing-selection-hover");
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerCancel);
    canvas.addEventListener("lostpointercapture", lostPointerCapture);
    canvas.addEventListener("pointerleave", leave);
    canvas.ownerDocument.addEventListener("keydown", keyDown);
  }

  function disable(): void {
    enabled = false;
    cancelQuery();
    detach();
    adapter.dispose();
    setPreparationProgress(null);
    selected = null;
    colors.clear();
    sceneRevision++;
    pointer = null;
    scene = null;
    options.onSelectionChange?.(null);
  }

  return {
    enable(): void {
      if (enabled) return;
      enabled = true;
      resetScene();
      attach();
    },
    disable,
    isEnabled: () => enabled,
    setSelectedColor(color: PrimitiveColorInput): void {
      if (selected) {
        const normalized = normalizePrimitiveColor(color);
        adapter.setOverrides([selected], normalized);
        colors.set(primitiveRefKey(selected), { ref: { ...selected }, color: normalized });
      }
      notifySelection();
    },
    resetSelectedColor(): void {
      if (selected) { adapter.clearOverrides([selected]); colors.delete(primitiveRefKey(selected)); }
      notifySelection();
    },
    resetAllColors(): void { adapter.clearOverrides(); colors.clear(); notifySelection(); },
    sceneChanged(): void { if (enabled) resetScene(); },
    rendererChanged(): void {
      if (!enabled) return;
      if (scene !== adapter.getScene()) { resetScene(); attach(); return; }
      cancelQuery();
      pointer = null;
      downs.clear();
      selectingGesture = false;
      attach();
      adapter.rendererChanged();
      setHover(null);
      for (const { ref, color } of colors.values()) adapter.setOverrides([ref], color);
      adapter.setSelection(selected ? [selected] : []);
      viewKey = currentViewKey();
    },
    onFrame(): void {
      if (!enabled) return;
      if (scene !== adapter.getScene()) resetScene();
      if (canvas !== adapter.getCanvas()) attach();
      const key = currentViewKey();
      if (key !== viewKey) {
        viewKey = key;
        const selection = pendingSelection();
        cancelQuery();
        setHover(null);
        // Retry a completed click against the updated view instead of silently
        // downgrading it to hover while the camera settles.
        if (selection && !selectingGesture) schedule(selection.point, true);
        else if (pointer && !selectingGesture) schedule(pointer, false);
      }
    },
    dispose: disable
  };
}


export type PrimitiveInteractionController = ReturnType<typeof createPrimitiveInteractionControllerForAdapter>;

/** Drawing selection for a native renderer; all pointer behavior is shared with Three. */
export function createPrimitiveInteractionController(options: PrimitiveInteractionOptions): PrimitiveInteractionController {
  let source: VectorScene | null = null;
  let renderer: RendererApi | null = null;
  let appearance: PrimitiveAppearanceState | null = null;
  let picker: ScenePrimitivePicker | null = null;
  let onProgress: (percentage: number | null) => void = () => {};
  let suppressCallbacks = false;
  const clear = (): void => {
    picker?.dispose(); picker = null;
    // The native renderer may already contain a replacement document.
    suppressCallbacks = source !== options.getScene();
    appearance?.dispose(); appearance = null;
    suppressCallbacks = false;
  };
  return createPrimitiveInteractionControllerForAdapter({
    getCanvas: options.getCanvas,
    getScene: options.getScene,
    getTarget: options.getRenderer,
    getViewKey: () => {
      // A presented view can lag behind the current projection by one frame.
      const view = options.getRenderer().getViewState();
      return `${view.cameraCenterX}:${view.cameraCenterY}:${view.zoom}`;
    },
    async pick(point, signal) {
      if (!source) return null;
      const target = options.getRenderer();
      const scenePoint = target.clientToScenePoint?.(point.x, point.y) ?? null;
      const rect = options.getCanvas().getBoundingClientRect();
      if (!scenePoint || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return null;
      picker ??= new ScenePrimitivePicker(source, percentage => onProgress(percentage));
      return picker.pick({ point: scenePoint, clientPoint: point,
        project: input => target.sceneToClientPoint?.(input.x, input.y) ?? null,
        unproject: input => target.clientToScenePoint?.(input.x, input.y) ?? null,
        tolerancePx: 4, signal });
    },
    setHover: ref => appearance?.setHover(ref),
    setSelection: refs => appearance?.setSelection(refs),
    setOverrides: (refs, color) => appearance?.setOverrides(refs, { color }),
    clearOverrides: refs => appearance?.clearOverrides(refs),
    sceneChanged(progress) {
      clear();
      source = options.getScene(); renderer = options.getRenderer(); onProgress = progress;
      renderer.setPrimitiveHighlights?.(null);
      if (source) appearance = new PrimitiveAppearanceState(source, {
        onColors: updates => { if (!suppressCallbacks) renderer?.setPrimitiveColorUpdates?.(updates); },
        onHighlights: highlights => { if (!suppressCallbacks) renderer?.setPrimitiveHighlights?.(highlights); }
      });
    },
    rendererChanged() {
      renderer = options.getRenderer();
      renderer.setPrimitiveColorUpdates?.(appearance?.getColorUpdates() ?? []);
      renderer.setPrimitiveHighlights?.(appearance?.getHighlights() ?? null);
    },
    dispose: clear
  }, options);
}
