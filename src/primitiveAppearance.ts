import { Color } from "three";
import type { Bounds, VectorClipPath, VectorScene } from "./pdfVectorExtractor";
import {
  getPrimitiveClipChain, getPrimitiveSegmentClipBounds, getScenePrimitive, validatePrimitiveRef,
  type PrimitiveKind, type PrimitiveRef
} from "./scenePrimitives";

export type PrimitiveColorInput = string | number | readonly [number, number, number];
export interface PrimitiveOverride { color: PrimitiveColorInput }
export interface PrimitiveColorUpdate {
  ref: PrimitiveRef;
  /** sRGB channels; null restores the immutable scene's original color. */
  color: [number, number, number] | null;
}

/** Compact canonical line/quadratic traces; selection precedes hover. */
export interface PrimitiveHighlightSet {
  /** Eight floats: start.xy, control.xy, end.xy, quadratic flag, clip index. */
  segments: Float32Array;
  clipPaths: VectorClipPath[];
  selectionCount: number;
  count: number;
}

export const PRIMITIVE_SELECTION_COLOR: readonly [number, number, number] = [0.15, 0.45, 1];
export const PRIMITIVE_HOVER_COLOR: readonly [number, number, number] = [1, 0.65, 0.05];
export const PRIMITIVE_TRACE_WIDTH_PX = 2;

export function primitiveRefKey(ref: PrimitiveRef): string { return `${ref.kind}:${ref.index}`; }

/** Parse without applying Three's automatic sRGB-to-linear conversion. */
export function normalizePrimitiveColor(input: PrimitiveColorInput): [number, number, number] {
  if (Array.isArray(input)) {
    if (input.length !== 3 || !input.every(Number.isFinite)) throw new TypeError("Invalid primitive color channels.");
    return input.map(value => Math.max(0, Math.min(1, value))) as [number, number, number];
  }
  let packed: number;
  if (typeof input === "number") packed = input;
  else if (typeof input === "string") {
    const value = input.trim().toLowerCase();
    if (/^#[\da-f]{3}$/.test(value)) packed = parseInt(value.slice(1).split("").map(c => c + c).join(""), 16);
    else if (/^#?[\da-f]{6}$/.test(value)) packed = parseInt(value.replace(/^#/, ""), 16);
    else if (Object.hasOwn(Color.NAMES, value)) packed = Color.NAMES[value as keyof typeof Color.NAMES];
    else throw new TypeError(`Unsupported primitive color: ${input}`);
  } else throw new TypeError("Invalid primitive color.");
  if (!Number.isInteger(packed) || packed < 0 || packed > 0xffffff) throw new TypeError("Invalid primitive color number.");
  return [(packed >>> 16) / 255, ((packed >>> 8) & 255) / 255, (packed & 255) / 255];
}

interface AppearanceCallbacks {
  onColors?(updates: readonly PrimitiveColorUpdate[]): void;
  onHighlights?(highlights: PrimitiveHighlightSet | null): void;
}

/** Viewer-owned interaction state. Never writes to the supplied VectorScene. */
export class PrimitiveAppearanceState {
  private readonly colors = new Map<string, PrimitiveColorUpdate>();
  private selected: PrimitiveRef[] = [];
  private hover: PrimitiveRef | null = null;
  private highlights: PrimitiveHighlightSet | null = null;
  private disposed = false;
  private readonly scene: VectorScene;
  private readonly callbacks: AppearanceCallbacks;

  constructor(scene: VectorScene, callbacks: AppearanceCallbacks = {}) {
    this.scene = scene;
    this.callbacks = callbacks;
  }

  getSelection(): PrimitiveRef[] { return this.selected.map(ref => ({ ...ref })); }
  getHover(): PrimitiveRef | null { return this.hover && { ...this.hover }; }
  getOverrideColor(ref: PrimitiveRef): [number, number, number] | null {
    validatePrimitiveRef(this.scene, ref);
    const color = this.colors.get(primitiveRefKey(ref))?.color;
    return color ? [...color] : null;
  }
  getHighlights(): PrimitiveHighlightSet | null { return this.highlights; }
  getColorUpdates(): PrimitiveColorUpdate[] {
    return [...this.colors.values()].map(({ ref, color }) => ({ ref: { ...ref }, color: color && [...color] }));
  }
  hasOverrides(kind: PrimitiveKind): boolean {
    for (const update of this.colors.values()) if (update.ref.kind === kind) return true;
    return false;
  }

  setHover(ref: PrimitiveRef | null): void {
    this.assertLive();
    if (ref) validatePrimitiveRef(this.scene, ref);
    if (ref ? this.hover && primitiveRefKey(ref) === primitiveRefKey(this.hover) : !this.hover) return;
    const next = ref && { ...ref };
    const highlights = buildPrimitiveHighlights(this.scene, this.selected, next);
    this.hover = next;
    this.highlights = highlights;
    this.callbacks.onHighlights?.(highlights);
  }

  setSelection(refs: readonly PrimitiveRef[]): void {
    this.assertLive();
    const next = this.validateRefs(refs);
    if (next.length === this.selected.length && next.every((ref, index) => primitiveRefKey(ref) === primitiveRefKey(this.selected[index]))) return;
    const highlights = buildPrimitiveHighlights(this.scene, next, this.hover);
    this.selected = next;
    this.highlights = highlights;
    this.callbacks.onHighlights?.(highlights);
  }

  setOverrides(refs: readonly PrimitiveRef[], override: PrimitiveOverride): void {
    this.assertLive();
    const next = this.validateRefs(refs);
    if (next.some(ref => ref.kind === "raster")) throw new TypeError("Raster layers support highlighting, but not color overrides.");
    const color = normalizePrimitiveColor(override?.color);
    const updates = next.filter(ref => {
      const previous = this.colors.get(primitiveRefKey(ref))?.color;
      return !previous || previous.some((value, channel) => value !== color[channel]);
    }).map(ref => ({ ref, color: [...color] as [number, number, number] }));
    for (const update of updates) this.colors.set(primitiveRefKey(update.ref), update);
    if (updates.length) this.callbacks.onColors?.(updates);
  }

  clearOverrides(refs?: readonly PrimitiveRef[]): void {
    this.assertLive();
    const next = refs === undefined ? [...this.colors.values()].map(update => update.ref) : this.validateRefs(refs);
    const updates: PrimitiveColorUpdate[] = [];
    for (const ref of next) if (this.colors.delete(primitiveRefKey(ref))) updates.push({ ref, color: null });
    if (updates.length) this.callbacks.onColors?.(updates);
  }

  clear(): void {
    this.assertLive();
    this.clearOverrides();
    const hadHighlights = this.highlights !== null;
    this.selected = [];
    this.hover = null;
    this.highlights = null;
    if (hadHighlights) this.callbacks.onHighlights?.(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("Primitive appearance state has been disposed.");
  }
  private validateRefs(refs: readonly PrimitiveRef[]): PrimitiveRef[] {
    if (!Array.isArray(refs)) throw new TypeError("Primitive references must be an array.");
    const unique = new Map<string, PrimitiveRef>();
    for (const ref of refs) {
      validatePrimitiveRef(this.scene, ref);
      unique.set(primitiveRefKey(ref), { ...ref });
    }
    return [...unique.values()];
  }
}

export function buildPrimitiveHighlights(
  scene: VectorScene, selected: readonly PrimitiveRef[], hover: PrimitiveRef | null
): PrimitiveHighlightSet | null {
  if (!selected.length && !hover) return null;
  const refs = hover ? [...selected, hover] : selected;
  let count = 0;
  let selectionCount = 0;
  for (let index = 0; index < refs.length; index++) {
    count += getScenePrimitive(scene, refs[index]).segmentCount;
    if (index === selected.length - 1) selectionCount = count;
  }
  if (!count) return null;
  const segments = new Float32Array(count * 8);
  const clipPaths: VectorClipPath[] = [];
  const clipMap = new Map<number, number>();
  const rectMap = new Map<string, number>();
  const copyClip = (index: number): number => {
    if (index < 0) return -1;
    const previous = clipMap.get(index);
    if (previous !== undefined) return previous;
    const clip = scene.clipPaths?.[index];
    if (!clip) throw new RangeError("Invalid primitive clip reference.");
    const parent = copyClip(clip.parent);
    const next = clipPaths.length;
    clipPaths.push({ parent, fillRule: clip.fillRule, edges: clip.edges.slice() });
    clipMap.set(index, next);
    return next;
  };
  const appendRect = (parent: number, rect: Bounds | undefined): number => {
    if (!rect) return parent;
    const { minX: x0, minY: y0, maxX: x1, maxY: y1 } = rect;
    const key = `${parent}:${x0}:${y0}:${x1}:${y1}`;
    const previous = rectMap.get(key);
    if (previous !== undefined) return previous;
    const next = clipPaths.length;
    clipPaths.push({ parent, fillRule: 0, edges: Float32Array.of(x0,y0,x1,y0, x1,y0,x1,y1, x1,y1,x0,y1, x0,y1,x0,y0) });
    rectMap.set(key, next);
    return next;
  };
  let cursor = 0;
  for (const ref of refs) {
    const primitive = getScenePrimitive(scene, ref);
    const clip = getPrimitiveClipChain(scene, ref);
    const baseClip = appendRect(copyClip(clip.clipIndex), clip.rect);
    for (let index = 0; index < primitive.segmentCount; index++) {
      const segment = primitive.getSegment(index);
      const control = segment.control ?? segment.end;
      const clipIndex = ref.kind === "gradient-stroke"
        ? appendRect(baseClip, getPrimitiveSegmentClipBounds(scene, ref, index)) : baseClip;
      segments.set([segment.start.x, segment.start.y, control.x, control.y, segment.end.x, segment.end.y,
        segment.control ? 1 : 0, clipIndex], cursor);
      cursor += 8;
    }
  }
  return { segments, clipPaths, selectionCount, count };
}
