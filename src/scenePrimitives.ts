import type { Bounds, VectorDrawRun, VectorScene } from "./pdfVectorExtractor";
import { defaultVectorDrawRuns } from "./vectorDrawOrder";
import { GRADIENT_LUT_WIDTH } from "./orderedGradientPaint";

export type PrimitiveKind = "stroke" | "fill" | "text" | "raster" | "gradient-fill" | "gradient-stroke";
/** An index in the canonical loaded scene, never an index in a rendering LOD. */
export interface PrimitiveRef { kind: PrimitiveKind; index: number }
export interface PrimitivePoint { x: number; y: number }
export interface PrimitiveSegment { start: PrimitivePoint; end: PrimitivePoint; control?: PrimitivePoint }
export interface PrimitiveSegmentStyle {
  /** Original sRGB color; null for gradient paint or raster RGBA data. */
  color: [number, number, number] | null;
  /** Paint opacity before a gradient source/mask or raster pixel alpha. */
  opacity: number;
  strokeWidth?: number;
  hairline?: boolean;
  roundCap?: boolean;
  /** Additional rectangular clip; the primitive's run clip chain also applies. */
  clipBounds?: Bounds;
}
export interface PrimitiveInfo {
  ref: PrimitiveRef;
  kind: PrimitiveKind;
  index: number;
  bounds: Bounds;
  pageIndex: number | null;
  /** Original sRGB color, or null for a gradient or mixed-color run. */
  color: [number, number, number] | null;
  /** Original opacity, or null for a run with differing member opacities. */
  opacity: number | null;
  segmentCount: number;
  /** Returns detached scene-space points. Quadratics retain their control point. */
  getSegment(index: number): PrimitiveSegment;
  /** Original style of this member, including varying styles within a gradient-stroke run. */
  getSegmentStyle(index: number): PrimitiveSegmentStyle;
  /** Gradient store index on gradient primitives; null means solid source paint. */
  gradientIndex?: number | null;
  /** Gradient store index on gradient primitives; null means no gradient mask. */
  maskGradientIndex?: number | null;
  strokeWidth?: number;
  fillRule?: "nonzero" | "evenodd";
  quad?: readonly PrimitivePoint[];
  width?: number;
  height?: number;
}
export interface PrimitiveHit {
  primitive: PrimitiveRef;
  point: PrimitivePoint;
  closestPoint: PrimitivePoint;
  distancePx: number;
  segmentIndex?: number;
}
export interface ScenePrimitivePickOptions {
  point: PrimitivePoint;
  clientPoint: PrimitivePoint;
  project(point: PrimitivePoint): PrimitivePoint | null;
  unproject(point: PrimitivePoint): PrimitivePoint | null;
  tolerancePx?: number;
  kinds?: readonly PrimitiveKind[];
  signal?: AbortSignal;
}

const KINDS: readonly PrimitiveKind[] = ["stroke", "fill", "text", "raster", "gradient-fill", "gradient-stroke"];
const ALPHA_EPSILON = 0.001;
const INDEX_BUDGET_BYTES = 128 * 1024 * 1024;
const YIELD_OPERATIONS = 1024;
const CURVE_ERROR_PX = 0.05;

function counts(scene: VectorScene): number[] {
  return [scene.segmentCount, scene.fillPathCount, scene.textInstanceCount, scene.rasterLayers.length,
    scene.gradientFillPathCount, scene.gradientStrokeRunCount];
}

export function validatePrimitiveRef(scene: VectorScene, ref: PrimitiveRef): void {
  const kind = ref ? KINDS.indexOf(ref.kind) : -1;
  if (kind < 0 || !Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index >= counts(scene)[kind]) {
    throw new RangeError("Primitive reference is outside the loaded scene.");
  }
}

interface RunLookup { runs: readonly VectorDrawRun[]; byKind: Map<PrimitiveKind, VectorDrawRun[]> }
const runLookups = new WeakMap<VectorScene, RunLookup>();
function getRuns(scene: VectorScene): RunLookup {
  let lookup = runLookups.get(scene);
  if (!lookup) {
    const runs = scene.drawRuns ?? defaultVectorDrawRuns(scene);
    const byKind = new Map<PrimitiveKind, VectorDrawRun[]>();
    for (const run of runs) {
      let list = byKind.get(run.kind);
      if (!list) byKind.set(run.kind, list = []);
      list.push(run);
    }
    for (const list of byKind.values()) list.sort((a, b) => a.first - b.first);
    lookup = { runs, byKind };
    runLookups.set(scene, lookup);
  }
  return lookup;
}

function primitiveRun(scene: VectorScene, ref: PrimitiveRef): VectorDrawRun | undefined {
  const runs = getRuns(scene).byKind.get(ref.kind) ?? [];
  const run = runs[runIndexAt(runs, ref.index)];
  return run && ref.index < run.first + run.count ? run : undefined;
}
function runIndexAt(runs: readonly VectorDrawRun[], index: number): number {
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid].first <= index) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Additional rectangular clips are intersected with the run's vector clip chain. */
export function getPrimitiveClipChain(scene: VectorScene, ref: PrimitiveRef): { clipIndex: number; rect?: Bounds } {
  validatePrimitiveRef(scene, ref);
  let rect: Bounds | undefined;
  if (ref.kind === "stroke") rect = strokeClip(scene.primitiveMeta, scene.primitiveBounds, ref.index);
  if (ref.kind === "text") {
    const index = Math.round(scene.textInstanceB[ref.index * 4 + 3]) - 1;
    if (index >= 0 && scene.textClipRects) rect = readBounds(scene.textClipRects, index * 4);
  }
  return { clipIndex: primitiveRun(scene, ref)?.clipIndex ?? -1, ...(rect ? { rect } : {}) };
}

export function getPrimitiveSegmentClipBounds(scene: VectorScene, ref: PrimitiveRef, segmentIndex: number): Bounds | undefined {
  validatePrimitiveRef(scene, ref);
  const store = segmentStore(scene, ref);
  validateSegmentIndex(segmentIndex, store.count);
  if (ref.kind === "gradient-stroke") return strokeClip(scene.gradientStrokePrimitiveMeta,
    scene.gradientStrokePrimitiveBounds, store.first + segmentIndex);
  return getPrimitiveClipChain(scene, ref).rect;
}

function strokeClip(meta: Float32Array, bounds: Float32Array, index: number): Bounds | undefined {
  return (styleFlags(meta[index * 4 + 3]) & 4) !== 0 ? readBounds(bounds, index * 4) : undefined;
}
function styleFlags(value: number): number { return Math.floor(value / 2 + 1e-6); }
function styleAlpha(value: number): number { return Math.max(0, Math.min(1, value - styleFlags(value) * 2)); }
function readBounds(values: Float32Array, offset: number): Bounds {
  return { minX: values[offset], minY: values[offset + 1], maxX: values[offset + 2], maxY: values[offset + 3] };
}
function emptyBounds(): Bounds { return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; }
function include(bounds: Bounds, point: PrimitivePoint, margin = 0): void {
  bounds.minX = Math.min(bounds.minX, point.x - margin); bounds.minY = Math.min(bounds.minY, point.y - margin);
  bounds.maxX = Math.max(bounds.maxX, point.x + margin); bounds.maxY = Math.max(bounds.maxY, point.y + margin);
}
function inBounds(point: PrimitivePoint, bounds: Bounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}
function finitePoint(point: PrimitivePoint | null): point is PrimitivePoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}
function transform(point: PrimitivePoint, matrix: ArrayLike<number>): PrimitivePoint {
  return { x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] };
}
function inverse(point: PrimitivePoint, matrix: ArrayLike<number>): PrimitivePoint | null {
  const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  const x = point.x - matrix[4], y = point.y - matrix[5];
  return { x: (matrix[3] * x - matrix[2] * y) / det, y: (matrix[0] * y - matrix[1] * x) / det };
}
function textMatrix(scene: VectorScene, index: number): number[] {
  const i = index * 4;
  return [scene.textInstanceA[i], scene.textInstanceA[i + 1], scene.textInstanceA[i + 2],
    scene.textInstanceA[i + 3], scene.textInstanceB[i], scene.textInstanceB[i + 1]];
}
interface SegmentStore { a: Float32Array; b: Float32Array; first: number; count: number; matrix?: number[] }
function segmentStore(scene: VectorScene, ref: PrimitiveRef): SegmentStore {
  const i = ref.index * 4;
  switch (ref.kind) {
    case "stroke": return { a: scene.endpoints, b: scene.primitiveMeta, first: ref.index, count: 1 };
    case "gradient-stroke": return { a: scene.gradientStrokeEndpoints, b: scene.gradientStrokePrimitiveMeta,
      first: Math.round(scene.gradientStrokeRunMetaA[i]), count: Math.round(scene.gradientStrokeRunMetaA[i + 1]) };
    case "fill": return { a: scene.fillSegmentsA, b: scene.fillSegmentsB,
      first: Math.round(scene.fillPathMetaA[i]), count: Math.round(scene.fillPathMetaA[i + 1]) };
    case "gradient-fill": return { a: scene.gradientFillSegmentsA, b: scene.gradientFillSegmentsB,
      first: Math.round(scene.gradientFillPathMetaA[i]), count: Math.round(scene.gradientFillPathMetaA[i + 1]) };
    case "text": {
      const glyph = Math.round(scene.textInstanceB[i + 2]) * 4;
      return { a: scene.textGlyphSegmentsA, b: scene.textGlyphSegmentsB,
        first: Math.round(scene.textGlyphMetaA[glyph]), count: Math.round(scene.textGlyphMetaA[glyph + 1]),
        matrix: textMatrix(scene, ref.index) };
    }
    case "raster": return { a: scene.endpoints, b: scene.primitiveMeta, first: 0, count: 4 };
  }
}
function validateSegmentIndex(index: number, count: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError("Primitive segment index is out of range.");
}
function readSegment(store: SegmentStore, index: number): PrimitiveSegment {
  const i = (store.first + index) * 4;
  const start = { x: store.a[i], y: store.a[i + 1] }, end = { x: store.b[i], y: store.b[i + 1] };
  const control = store.b[i + 2] >= 0.5 ? { x: store.a[i + 2], y: store.a[i + 3] } : undefined;
  return { start: store.matrix ? transform(start, store.matrix) : start,
    end: store.matrix ? transform(end, store.matrix) : end,
    ...(control ? { control: store.matrix ? transform(control, store.matrix) : control } : {}) };
}
function rasterQuad(scene: VectorScene, index: number): PrimitivePoint[] {
  return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    .map(point => transform(point, scene.rasterLayers[index].matrix));
}
function primitiveBounds(scene: VectorScene, ref: PrimitiveRef): Bounds {
  const i = ref.index * 4;
  if (ref.kind === "fill" || ref.kind === "gradient-fill") {
    const a = ref.kind === "fill" ? scene.fillPathMetaA : scene.gradientFillPathMetaA;
    const b = ref.kind === "fill" ? scene.fillPathMetaB : scene.gradientFillPathMetaB;
    return { minX: a[i + 2], minY: a[i + 3], maxX: b[i], maxY: b[i + 1] };
  }
  const bounds = emptyBounds();
  if (ref.kind === "raster") {
    for (const point of rasterQuad(scene, ref.index)) include(bounds, point);
  } else if (ref.kind === "text") {
    const glyph = Math.round(scene.textInstanceB[i + 2]) * 4;
    const matrix = textMatrix(scene, ref.index);
    for (const x of [scene.textGlyphMetaA[glyph + 2], scene.textGlyphMetaB[glyph]])
      for (const y of [scene.textGlyphMetaA[glyph + 3], scene.textGlyphMetaB[glyph + 1]]) include(bounds, transform({ x, y }, matrix));
  } else {
    const store = segmentStore(scene, ref);
    const styles = ref.kind === "stroke" ? scene.styles : scene.gradientStrokeStyles;
    for (let j = 0; j < store.count; j++) {
      const segment = readSegment(store, j), margin = Math.max(0, styles[(store.first + j) * 4]);
      include(bounds, segment.start, margin); include(bounds, segment.end, margin);
      if (segment.control) include(bounds, segment.control, margin);
    }
  }
  return bounds;
}
function primitivePage(scene: VectorScene, ref: PrimitiveRef, bounds: Bounds): number | null {
  if (ref.kind === "raster") return scene.rasterLayers[ref.index].pageIndex;
  if (ref.kind === "gradient-fill") return scene.gradientFillPaintMeta[ref.index * 4 + 3];
  if (ref.kind === "gradient-stroke") return scene.gradientStrokeRunMetaB[ref.index * 4 + 1];
  if (ref.kind === "text") {
    for (let i = 0; i < scene.pageTextRanges.length; i += 2)
      if (ref.index >= scene.pageTextRanges[i] && ref.index < scene.pageTextRanges[i] + scene.pageTextRanges[i + 1]) return i / 2;
  }
  let page: number | null = null;
  for (let i = 0; i < scene.pageRects.length; i += 4) {
    const rect = readBounds(scene.pageRects, i);
    if (bounds.maxX < rect.minX || bounds.minX > rect.maxX || bounds.maxY < rect.minY || bounds.minY > rect.maxY) continue;
    if (page !== null) return null;
    page = i / 4;
  }
  return page;
}

export function getScenePrimitive(scene: VectorScene, reference: PrimitiveRef): PrimitiveInfo {
  validatePrimitiveRef(scene, reference);
  const ref = { ...reference }, i = ref.index * 4, store = segmentStore(scene, ref);
  let color: PrimitiveInfo["color"] = null, opacity: number | null = 1;
  let fillRule: PrimitiveInfo["fillRule"];
  if (ref.kind === "stroke" || ref.kind === "gradient-stroke") {
    const styles = ref.kind === "stroke" ? scene.styles : scene.gradientStrokeStyles;
    const first = store.first * 4;
    color = [styles[first + 1], styles[first + 2], styles[first + 3]];
    opacity = store.count ? styleAlpha(store.b[first + 3]) : 0;
    for (let j = 1; j < store.count; j++) {
      const offset = (store.first + j) * 4;
      if (color && color.some((value, channel) => value !== styles[offset + channel + 1])) color = null;
      if (opacity !== styleAlpha(store.b[offset + 3])) opacity = null;
    }
    if (ref.kind === "gradient-stroke" && scene.gradientStrokeRunMetaA[i + 2] >= 0) color = null;
  } else if (ref.kind === "fill" || ref.kind === "gradient-fill") {
    const b = ref.kind === "fill" ? scene.fillPathMetaB : scene.gradientFillPathMetaB;
    const c = ref.kind === "fill" ? scene.fillPathMetaC : scene.gradientFillPathMetaC;
    color = [b[i + 2], b[i + 3], c[i + 2]]; opacity = c[i + 3];
    fillRule = c[i] >= 0.5 ? "evenodd" : "nonzero";
    if (ref.kind === "gradient-fill" && scene.gradientFillPaintMeta[i] >= 0) color = null;
  } else if (ref.kind === "text") {
    color = [scene.textInstanceC[i], scene.textInstanceC[i + 1], scene.textInstanceC[i + 2]];
    opacity = scene.textInstanceC[i + 3]; fillRule = "nonzero";
  }
  const bounds = primitiveBounds(scene, ref);
  const quad = ref.kind === "raster" ? rasterQuad(scene, ref.index) : undefined;
  const gradientPaint = ref.kind === "gradient-fill" ? scene.gradientFillPaintMeta :
    ref.kind === "gradient-stroke" ? scene.gradientStrokeRunMetaA : undefined;
  const gradientOffset = ref.kind === "gradient-stroke" ? 2 : 0;
  const gradientIndex = gradientPaint && gradientPaint[i + gradientOffset] >= 0 ? gradientPaint[i + gradientOffset] : null;
  const maskGradientIndex = gradientPaint && gradientPaint[i + gradientOffset + 1] >= 0 ? gradientPaint[i + gradientOffset + 1] : null;
  return { ref: { ...ref }, kind: ref.kind, index: ref.index, bounds, pageIndex: primitivePage(scene, ref, bounds), color, opacity,
    segmentCount: store.count, ...(fillRule ? { fillRule } : {}),
    ...(gradientPaint ? { gradientIndex, maskGradientIndex } : {}),
    ...(ref.kind === "stroke" ? { strokeWidth: 2 * scene.styles[i] } : {}),
    ...(quad ? { quad, width: scene.rasterLayers[ref.index].width, height: scene.rasterLayers[ref.index].height } : {}),
    getSegment(index) {
      validateSegmentIndex(index, store.count);
      if (quad) return { start: { ...quad[index] }, end: { ...quad[(index + 1) % 4] } };
      return readSegment(store, index);
    },
    getSegmentStyle(index) {
      validateSegmentIndex(index, store.count);
      const clipBounds = getPrimitiveSegmentClipBounds(scene, ref, index);
      const clip = clipBounds ? { clipBounds } : {};
      if (ref.kind === "stroke" || ref.kind === "gradient-stroke") {
        const styles = ref.kind === "stroke" ? scene.styles : scene.gradientStrokeStyles;
        const offset = (store.first + index) * 4, encoded = store.b[offset + 3], flags = styleFlags(encoded);
        return { color: gradientIndex === null ? [styles[offset + 1], styles[offset + 2], styles[offset + 3]] : null,
          opacity: styleAlpha(encoded), strokeWidth: 2 * styles[offset], hairline: (flags & 1) !== 0,
          roundCap: (flags & 2) !== 0, ...clip };
      }
      if (ref.kind === "fill" || ref.kind === "gradient-fill") {
        const b = ref.kind === "fill" ? scene.fillPathMetaB : scene.gradientFillPathMetaB;
        const c = ref.kind === "fill" ? scene.fillPathMetaC : scene.gradientFillPathMetaC;
        return { color: gradientIndex === null ? [b[i + 2], b[i + 3], c[i + 2]] : null, opacity: c[i + 3], ...clip };
      }
      if (ref.kind === "text") return { color: [scene.textInstanceC[i], scene.textInstanceC[i + 1], scene.textInstanceC[i + 2]],
        opacity: scene.textInstanceC[i + 3], ...clip };
      return { color: null, opacity: 1, ...clip };
    } };
}

function lineWinding(a: PrimitivePoint, b: PrimitivePoint, point: PrimitivePoint): number {
  if ((a.y > point.y) === (b.y > point.y)) return 0;
  const x = a.x + (point.y - a.y) / (b.y - a.y) * (b.x - a.x);
  return x > point.x ? (b.y > a.y ? 1 : -1) : 0;
}
function quadraticPoint(segment: PrimitiveSegment, t: number): PrimitivePoint {
  if (!segment.control) return { x: segment.start.x + (segment.end.x - segment.start.x) * t,
    y: segment.start.y + (segment.end.y - segment.start.y) * t };
  const s = 1 - t;
  return { x: s * s * segment.start.x + 2 * s * t * segment.control.x + t * t * segment.end.x,
    y: s * s * segment.start.y + 2 * s * t * segment.control.y + t * t * segment.end.y };
}
function segmentWinding(segment: PrimitiveSegment, point: PrimitivePoint): number {
  if (!segment.control) return lineWinding(segment.start, segment.end, point);
  const a = segment.start.y - 2 * segment.control.y + segment.end.y;
  const b = 2 * (segment.control.y - segment.start.y), c = segment.start.y - point.y;
  const roots = quadraticRoots(a, b, c);
  let winding = 0;
  for (const t of roots) if (t >= 0 && t < 1 && quadraticPoint(segment, t).x > point.x) {
    const dy = 2 * a * t + b;
    if (Math.abs(dy) > 1e-12) winding += dy > 0 ? 1 : -1;
  }
  return winding;
}
function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) <= 1e-14 * Math.max(1, Math.abs(b))) return Math.abs(b) > 1e-20 ? [-c / b] : [];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  if (root === 0) return [-b / (2 * a)];
  const q = -0.5 * (b + (b < 0 ? -root : root));
  return [q / a, c / q];
}
function withinClips(scene: VectorScene, point: PrimitivePoint, clipIndex: number, rect?: Bounds): boolean {
  if (rect && !inBounds(point, rect)) return false;
  for (let depth = 0; clipIndex >= 0; depth++) {
    const clip = scene.clipPaths?.[clipIndex];
    if (!clip || depth >= 64) return false;
    let winding = 0;
    for (let i = 0; i < clip.edges.length; i += 4) winding += lineWinding(
      { x: clip.edges[i], y: clip.edges[i + 1] }, { x: clip.edges[i + 2], y: clip.edges[i + 3] }, point);
    if (clip.fillRule ? Math.abs(winding) % 2 === 0 : winding === 0) return false;
    clipIndex = clip.parent;
  }
  return true;
}

/** Matches the retained gradient shaders, including radial root and LUT alpha. */
function gradientAlpha(scene: VectorScene, index: number, point: PrimitivePoint): number {
  if (index < 0) return 1;
  if (index >= scene.gradientCount) return 0;
  const i = index * 4, a = scene.gradientMetaA, b = scene.gradientMetaB, c = scene.gradientMetaC;
  const d = scene.gradientMetaD, e = scene.gradientMetaE;
  const p = { x: b[i] * point.x + b[i + 2] * point.y + c[i], y: b[i + 1] * point.x + b[i + 3] * point.y + c[i + 1] };
  if (a[i + 1] >= 0.5 && !inBounds(p, readBounds(e, i))) return 0;
  const x = p.x - c[i + 2], y = p.y - c[i + 3], dx = d[i] - c[i + 2], dy = d[i + 1] - c[i + 3];
  let t: number;
  if (a[i] < 0.5) {
    const denominator = dx * dx + dy * dy;
    if (denominator <= 1e-12) return 0;
    t = (x * dx + y * dy) / denominator;
  } else {
    const radius = d[i + 2], delta = d[i + 3] - radius;
    const roots = quadraticRoots(dx * dx + dy * dy - delta * delta,
      -2 * (x * dx + y * dy + radius * delta), x * x + y * y - radius * radius)
      .filter(root => Number.isFinite(root) && radius + root * delta >= 0);
    if (!roots.length) return 0;
    t = Math.max(...roots);
  }
  const sample = Math.max(0, Math.min(1, t)) * (GRADIENT_LUT_WIDTH - 1), lo = Math.floor(sample), fraction = sample - lo;
  const base = index * GRADIENT_LUT_WIDTH * 4;
  const left = scene.gradientLut[base + lo * 4 + 3], right = scene.gradientLut[base + Math.min(lo + 1, GRADIENT_LUT_WIDTH - 1) * 4 + 3];
  return (left * (1 - fraction) + right * fraction) / 255;
}
function rasterAlpha(scene: VectorScene, index: number, point: PrimitivePoint): number {
  const layer = scene.rasterLayers[index], uv = inverse(point, layer.matrix);
  if (!uv || uv.x < 0 || uv.y < 0 || uv.x > 1 || uv.y > 1 || !layer.width || !layer.height) return 0;
  const x = uv.x * layer.width - 0.5, y = uv.y * layer.height - 0.5, ix = Math.floor(x), iy = Math.floor(y);
  const alpha = (px: number, py: number): number => layer.data[(Math.max(0, Math.min(layer.height - 1, py)) * layer.width +
    Math.max(0, Math.min(layer.width - 1, px))) * 4 + 3] / 255;
  const fx = x - ix, fy = y - iy;
  return (alpha(ix, iy) * (1 - fx) + alpha(ix + 1, iy) * fx) * (1 - fy) +
    (alpha(ix, iy + 1) * (1 - fx) + alpha(ix + 1, iy + 1) * fx) * fy;
}

interface Nearest { point: PrimitivePoint; distance: number }
function closestLine(a: PrimitivePoint, b: PrimitivePoint, point: PrimitivePoint): { t: number; distance: number } {
  const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2)) : 0;
  return { t, distance: Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) };
}
async function nearestProjected(
  segment: PrimitiveSegment, options: ScenePrimitivePickOptions, work: Work,
  pointAt?: (t: number) => PrimitivePoint
): Promise<Nearest | null> {
  let best: Nearest | null = null;
  const at = pointAt ?? ((t: number) => quadraticPoint(segment, t));
  const visit = async (t0: number, t1: number, a: PrimitivePoint | null, b: PrimitivePoint | null, depth: number): Promise<void> => {
    if (work.shouldYield()) await work.yield();
    const mid = (t0 + t1) * 0.5, m = options.project(at(mid));
    if (!finitePoint(a) || !finitePoint(b) || !finitePoint(m)) {
      if (depth < 12 && (a || b || m)) { await visit(t0, mid, a, m, depth + 1); await visit(mid, t1, m, b, depth + 1); }
      return;
    }
    // Check quarter points too: a projected curve can double back around its midpoint.
    const q0 = options.project(at((t0 + mid) * 0.5));
    const q1 = options.project(at((mid + t1) * 0.5));
    const error = Math.max(closestLine(a, b, m).distance,
      finitePoint(q0) ? closestLine(a, b, q0).distance : Infinity,
      finitePoint(q1) ? closestLine(a, b, q1).distance : Infinity);
    if (depth < 16 && error > CURVE_ERROR_PX) {
      await visit(t0, mid, a, m, depth + 1); await visit(mid, t1, m, b, depth + 1); return;
    }
    const nearest = closestLine(a, b, options.clientPoint);
    // Unprojection recovers perspective-correct scene positions along projected lines.
    const screen = { x: a.x + (b.x - a.x) * nearest.t, y: a.y + (b.y - a.y) * nearest.t };
    let point: PrimitivePoint;
    if (!segment.control && !pointAt) point = options.unproject(screen) ?? at(t0 + (t1 - t0) * nearest.t);
    else {
      // Refine parameter against the actual projected curve, not the flattened chord.
      let lo = t0, hi = t1;
      for (let step = 0; step < 18; step++) {
        const left = lo + (hi - lo) / 3, right = hi - (hi - lo) / 3;
        const lp = options.project(at(left)), rp = options.project(at(right));
        if (!lp || !rp) break;
        if (Math.hypot(lp.x - options.clientPoint.x, lp.y - options.clientPoint.y) <=
            Math.hypot(rp.x - options.clientPoint.x, rp.y - options.clientPoint.y)) hi = right; else lo = left;
      }
      const candidates = [t0, t1, (lo + hi) * 0.5];
      let tBest = candidates[0], dBest = Infinity;
      for (const t of candidates) {
        const p = options.project(at(t));
        const distance = p ? Math.hypot(p.x - options.clientPoint.x, p.y - options.clientPoint.y) : Infinity;
        if (distance < dBest) { dBest = distance; tBest = t; }
      }
      point = at(tBest);
    }
    const projected = options.project(point);
    if (!finitePoint(projected)) return;
    const distance = Math.hypot(projected.x - options.clientPoint.x, projected.y - options.clientPoint.y);
    if (!best || distance < best.distance) best = { point, distance };
  };
  await visit(0, 1, options.project(at(0)), options.project(at(1)), 0);
  return best;
}

/** Project the actual stroke ribbon and caps; a scalar zoom is wrong under shear/nonuniform scale. */
async function nearestStrokeFootprint(
  segment: PrimitiveSegment, halfWidth: number, options: ScenePrimitivePickOptions, work: Work,
  centerline: Nearest
): Promise<Nearest | null> {
  if (halfWidth <= 0) return centerline;
  const localNearest = segment.control ? await nearestProjected(segment, {
    ...options, clientPoint: options.point, project: point => point, unproject: point => point
  }, work) : { distance: closestLine(segment.start, segment.end, options.point).distance };
  if (localNearest && localNearest.distance <= halfWidth + 1e-10) return { point: { ...options.point }, distance: 0 };
  let best: Nearest | null = null;
  const consider = async (at: (t: number) => PrimitivePoint, straight = false): Promise<void> => {
    const candidate = await nearestProjected({ start: at(0), end: at(1) }, options, work, straight ? undefined : at);
    if (candidate && (!best || candidate.distance < best.distance)) best = candidate;
  };
  const tangent = (t: number): PrimitivePoint => {
    const control = segment.control;
    let x = control ? (1 - t) * (control.x - segment.start.x) + t * (segment.end.x - control.x) : segment.end.x - segment.start.x;
    let y = control ? (1 - t) * (control.y - segment.start.y) + t * (segment.end.y - control.y) : segment.end.y - segment.start.y;
    let length = Math.hypot(x, y);
    if (length <= 1e-15) {
      x = segment.end.x - segment.start.x; y = segment.end.y - segment.start.y;
      length = Math.hypot(x, y);
    }
    return length ? { x: x / length, y: y / length } : { x: 1, y: 0 };
  };
  for (const side of [-1, 1]) await consider(t => {
    const point = quadraticPoint(segment, t), direction = tangent(t);
    return { x: point.x - direction.y * halfWidth * side, y: point.y + direction.x * halfWidth * side };
  }, !segment.control);
  // Full end disks are all part of the painted stroke, and remain correct for
  // degenerate round points and curves whose endpoint tangents reverse.
  const circle = async (center: PrimitivePoint): Promise<void> => {
    for (let quarter = 0; quarter < 4; quarter++) await consider(t => {
      const angle = (quarter + t) * Math.PI / 2;
      return { x: center.x + halfWidth * Math.cos(angle), y: center.y + halfWidth * Math.sin(angle) };
    });
  };
  await circle(segment.start);
  if (segment.start.x !== segment.end.x || segment.start.y !== segment.end.y) await circle(segment.end);
  if (segment.control) {
    const ax = segment.control.x - segment.start.x, ay = segment.control.y - segment.start.y;
    const bx = segment.end.x - 2 * segment.control.x + segment.start.x;
    const by = segment.end.y - 2 * segment.control.y + segment.start.y;
    const t = Math.abs(bx) >= Math.abs(by) ? -ax / bx : -ay / by;
    if (t > 0 && t < 1 && Math.hypot(ax + t * bx, ay + t * by) <= 1e-10) await circle(quadraticPoint(segment, t));
  }
  return best;
}

/** Yield by elapsed time as well as work count; cancellation is observed during builds and queries. */
class Work {
  private operations = 0;
  private time = performance.now();
  private readonly check: () => void;
  private progressOperations = 0;
  private nextProgressOperation = Infinity;
  private onProgress: ((percentage: number) => void) | undefined;
  constructor(check: () => void) { this.check = check; }
  setProgress(totalOperations: number, onProgress: (percentage: number) => void): void {
    this.operations = 0;
    this.progressOperations = totalOperations;
    this.nextProgressOperation = Math.ceil(totalOperations / 100);
    this.onProgress = onProgress;
  }
  // Keep the common path synchronous: a resolved Promise per item becomes
  // millions of unnecessary microtasks while constructing a dense index.
  shouldYield(): boolean {
    this.check();
    this.operations++;
    if (this.operations >= this.nextProgressOperation) {
      // Report at most once per integer percentage, without a callback or a
      // Promise per item. Completion is reported only after installing the index.
      const percentage = Math.min(99, Math.floor(this.operations * 100 / this.progressOperations));
      this.nextProgressOperation = percentage === 99 ? Infinity : Math.ceil((percentage + 1) * this.progressOperations / 100);
      this.onProgress?.(percentage);
      this.check();
    }
    return this.operations % YIELD_OPERATIONS === 0 && performance.now() - this.time >= 8;
  }
  async yield(): Promise<void> {
    this.check();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    this.time = performance.now();
    this.check();
  }
}

interface PackedIndex {
  ids: Uint32Array;
  bounds: Float64Array;
  ranks: Uint32Array;
  maxRanks: Uint32Array;
  levels: number[];
  sizes: number[];
  offsets: number[];
  /** Dense scenes share a leaf between consecutive canonical primitives. */
  groupSize: number;
  total: number;
  runRanks?: Map<PrimitiveKind, Float64Array>;
}
function spread16(value: number): number {
  value = (value | value << 8) & 0x00ff00ff;
  value = (value | value << 4) & 0x0f0f0f0f;
  value = (value | value << 2) & 0x33333333;
  return (value | value << 1) & 0x55555555;
}
function refFromId(id: number, offsets: number[]): PrimitiveRef {
  let kind = KINDS.length - 1;
  while (kind && id < offsets[kind]) kind--;
  return { kind: KINDS[kind], index: id - offsets[kind] };
}
function intersects(bounds: Float64Array, index: number, query: Bounds): boolean {
  const i = index * 4;
  return bounds[i] <= query.maxX && bounds[i + 1] <= query.maxY && bounds[i + 2] >= query.minX && bounds[i + 3] >= query.minY;
}
function boundsIntersect(bounds: Bounds, query: Bounds): boolean {
  return bounds.minX <= query.maxX && bounds.minY <= query.maxY && bounds.maxX >= query.minX && bounds.maxY >= query.minY;
}

function paintRank(scene: VectorScene, ref: PrimitiveRef, runRanks?: Map<PrimitiveKind, Float64Array>): number {
  const lookup = getRuns(scene);
  if (runRanks) {
    const runs = lookup.byKind.get(ref.kind) ?? [], index = runIndexAt(runs, ref.index);
    return index < 0 ? -1 : runRanks.get(ref.kind)![index] + ref.index - runs[index].first;
  }
  // Exceptionally fragmented scenes may spend the entire budget on run ranks.
  // In that case look up only spatial candidates, retaining the bounded tree.
  let rank = 0;
  for (const run of lookup.runs) {
    if (run.kind === ref.kind && ref.index >= run.first && ref.index < run.first + run.count)
      return rank + ref.index - run.first;
    rank += run.count;
  }
  return -1;
}

/** CPU query of retained geometry. Source arrays stay unchanged and no index is serialized. */
export class ScenePrimitivePicker {
  private index: PackedIndex | null = null;
  private empty = false;
  private disposed = false;
  private building: Promise<void> | null = null;
  private readonly scene: VectorScene;
  private readonly onBuildProgress: ((percentage: number | null) => void) | undefined;
  /** Build progress is shared by all requests; null indicates a failed build. */
  constructor(scene: VectorScene, onBuildProgress?: (percentage: number | null) => void) {
    this.scene = scene;
    this.onBuildProgress = onBuildProgress;
  }

  dispose(): void { this.disposed = true; this.index = null; runLookups.delete(this.scene); }

  async pick(options: ScenePrimitivePickOptions): Promise<PrimitiveHit | null> {
    const check = (): void => {
      options.signal?.throwIfAborted();
      if (this.disposed) throw new Error("Primitive picker has been disposed.");
    };
    check();
    const tolerance = options.tolerancePx ?? 4;
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError("Picking tolerance must be a finite nonnegative CSS pixel value.");
    if (!finitePoint(options.point) || !finitePoint(options.clientPoint)) return null;
    if (options.kinds?.some(kind => !KINDS.includes(kind))) throw new RangeError("Unknown primitive kind.");
    const work = new Work(check);
    if (!this.index && !this.empty) {
      // A caller aborts its own wait; a shared build is owned by the picker and disposal.
      if (!this.building) {
        this.building = this.build(new Work(() => { if (this.disposed) throw new Error("Primitive picker has been disposed."); }))
          .catch(error => { this.reportBuildProgress(null); throw error; })
          .finally(() => { this.building = null; });
      }
      await this.waitForBuild(this.building, options.signal);
      check();
    }
    const allowed = options.kinds ? new Set(options.kinds) : null;
    let best: PrimitiveHit | null = null, bestRank = -1;
    const candidate = async (ref: PrimitiveRef, rank: number): Promise<void> => {
      if (rank <= bestRank || (allowed && !allowed.has(ref.kind))) return;
      const hit = await this.hit(ref, options, tolerance, work);
      if (hit) { best = hit; bestRank = rank; }
    };
    if (this.index) {
      const index = this.index, query = emptyBounds();
      // The tolerance disk is contained by this CSS square. A horizon-crossing
      // projection disables bounds rejection instead of missing visible geometry.
      let bounded = true;
      for (const dx of [-tolerance - 1, 0, tolerance + 1]) for (const dy of [-tolerance - 1, 0, tolerance + 1]) {
        const point = options.unproject({ x: options.clientPoint.x + dx, y: options.clientPoint.y + dy });
        if (finitePoint(point)) include(query, point); else bounded = false;
      }
      if (bounded) {
        const radius = tolerance + 1;
        const corners = [[-radius, -radius], [radius, -radius], [radius, radius], [-radius, radius]]
          .map(([x, y]) => options.unproject({ x: options.clientPoint.x + x, y: options.clientPoint.y + y }));
        let sign = 0;
        for (let j = 0; j < 4; j++) {
          const a = corners[j], b = corners[(j + 1) % 4], c = corners[(j + 2) % 4];
          if (!finitePoint(a) || !finitePoint(b) || !finitePoint(c)) { bounded = false; break; }
          const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
          // A homography crossing its horizon can have finite corner samples
          // while mapping the square to a folded, unbounded region.
          if (!Number.isFinite(cross) || cross === 0 || (sign && Math.sign(cross) !== sign)) { bounded = false; break; }
          sign = Math.sign(cross);
        }
      }
      if (!bounded) Object.assign(query, { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity });
      const stack: number[] = [index.levels.length - 1, index.levels[index.levels.length - 1]];
      while (stack.length) {
        const node = stack.pop()!, level = stack.pop()!;
        if (index.maxRanks[node] <= bestRank || !intersects(index.bounds, node, query)) continue;
        if (level === 0) {
          const group = index.ids[node], first = group * index.groupSize;
          for (let id = Math.min(first + index.groupSize, index.total) - 1; id >= first; id--) {
            const ref = refFromId(id, index.offsets);
            if (!allowed || allowed.has(ref.kind)) {
              const rank = index.groupSize === 1 ? index.ranks[group] : paintRank(this.scene, ref, index.runRanks);
              // A coarse leaf can cover empty space between its members. Reject
              // those members before doing projected curves and stroke caps.
              // Gradient runs may contain many segments; their member tests yield.
              if (rank > bestRank && (index.groupSize === 1 || ref.kind === "gradient-stroke" ||
                  boundsIntersect(primitiveBounds(this.scene, ref), query))) await candidate(ref, rank);
            }
            if (work.shouldYield()) await work.yield();
          }
        } else {
          const child = index.levels[level - 1] + 2 * (node - index.levels[level]);
          const second = child + 1, end = index.levels[level - 1] + index.sizes[level - 1];
          if (second < end && index.maxRanks[second] < index.maxRanks[child]) {
            stack.push(level - 1, second, level - 1, child);
          } else {
            stack.push(level - 1, child);
            if (second < end) stack.push(level - 1, second);
          }
        }
        if (work.shouldYield()) await work.yield();
      }
    }
    check();
    return best;
  }

  private async waitForBuild(build: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return build;
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { await Promise.race([build, aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  private async build(work: Work): Promise<void> {
    this.reportBuildProgress(0);
    const sizesByKind = counts(this.scene), offsets: number[] = [];
    let total = 0;
    for (const count of sizesByKind) { offsets.push(total); total += count; }
    if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("Invalid primitive count.");
    if (total === 0) {
      this.empty = true;
      this.reportBuildProgress(100);
      return;
    }
    await work.yield();
    const lookup = getRuns(this.scene), runs = lookup.runs;
    // Keep a spatial index at every scene size. Above the budget, fewer leaves
    // enclose small groups instead of switching to an unbounded full-page scan.
    const grouped = total * 128 + 4096 > INDEX_BUDGET_BYTES;
    const rankBytes = grouped && runs.length * 8 < INDEX_BUDGET_BYTES / 2 ? runs.length * 8 : 0;
    const maxLeaves = Math.floor((INDEX_BUDGET_BYTES - rankBytes - 4096) / 128);
    const groupSize = Math.max(1, Math.ceil(total / maxLeaves)), leafCount = Math.ceil(total / groupSize);
    const runRanks = rankBytes ? new Map<PrimitiveKind, Float64Array>() : undefined;
    if (runRanks) for (const [kind, list] of lookup.byKind) runRanks.set(kind, new Float64Array(list.length));
    const levels = [0], sizes = [leafCount];
    let nodes = leafCount;
    while (sizes[sizes.length - 1] > 1) { const size = Math.ceil(sizes[sizes.length - 1] / 2); levels.push(nodes); sizes.push(size); nodes += size; }
    if (this.onBuildProgress) {
      let rankCount = 0, gradientMembers = 0;
      for (const run of runs) { rankCount += run.count; if (work.shouldYield()) await work.yield(); }
      for (let i = 0; i < this.scene.gradientStrokeRunCount; i++) {
        gradientMembers += Math.max(0, Math.round(this.scene.gradientStrokeRunMetaA[i * 4 + 1]));
        if (work.shouldYield()) await work.yield();
      }
      // Bounds, Morton codes, eight radix loops, ranks, run members, and all
      // hierarchy nodes. Count referenced members, not unused backing storage.
      work.setProgress(total + leafCount * 9 + rankCount + gradientMembers + nodes, percentage => this.reportBuildProgress(percentage));
    }
    const ids = new Uint32Array(leafCount), ranks = new Uint32Array(leafCount), codes = new Uint32Array(leafCount);
    const rawBounds = new Float64Array(leafCount * 4), bounds = emptyBounds();
    for (let id = 0; id < total; id++) {
      const ref = refFromId(id, offsets);
      let b: Bounds;
      if (ref.kind === "gradient-stroke") {
        b = emptyBounds();
        const store = segmentStore(this.scene, ref);
        for (let j = 0; j < store.count; j++) {
          const segment = readSegment(store, j), margin = Math.max(0, this.scene.gradientStrokeStyles[(store.first + j) * 4]);
          include(b, segment.start, margin); include(b, segment.end, margin);
          if (segment.control) include(b, segment.control, margin);
          if (work.shouldYield()) await work.yield();
        }
      } else b = primitiveBounds(this.scene, ref);
      const group = Math.floor(id / groupSize), offset = group * 4;
      if (id % groupSize === 0) {
        rawBounds.set([b.minX, b.minY, b.maxX, b.maxY], offset);
        ids[group] = group;
      } else {
        rawBounds[offset] = Math.min(rawBounds[offset], b.minX);
        rawBounds[offset + 1] = Math.min(rawBounds[offset + 1], b.minY);
        rawBounds[offset + 2] = Math.max(rawBounds[offset + 2], b.maxX);
        rawBounds[offset + 3] = Math.max(rawBounds[offset + 3], b.maxY);
      }
      include(bounds, { x: b.minX, y: b.minY }); include(bounds, { x: b.maxX, y: b.maxY });
      if (work.shouldYield()) await work.yield();
    }
    let rank = 0;
    for (const run of runs) {
      const base = offsets[KINDS.indexOf(run.kind)];
      if (runRanks) runRanks.get(run.kind)![runIndexAt(lookup.byKind.get(run.kind)!, run.first)] = rank;
      for (let i = run.first; i < run.first + run.count; i++) {
        const group = Math.floor((base + i) / groupSize);
        ranks[group] = Math.max(ranks[group], rank++);
        if (work.shouldYield()) await work.yield();
      }
    }
    const width = Math.max(1e-12, bounds.maxX - bounds.minX), height = Math.max(1e-12, bounds.maxY - bounds.minY);
    for (let id = 0; id < leafCount; id++) {
      const i = id * 4;
      const x = Math.max(0, Math.min(65535, Math.floor(((rawBounds[i] + rawBounds[i + 2]) * 0.5 - bounds.minX) / width * 65535)));
      const y = Math.max(0, Math.min(65535, Math.floor(((rawBounds[i + 1] + rawBounds[i + 3]) * 0.5 - bounds.minY) / height * 65535)));
      codes[id] = (spread16(x) | spread16(y) << 1) >>> 0;
      if (work.shouldYield()) await work.yield();
    }
    const scratch = new Uint32Array(leafCount), buckets = new Uint32Array(256);
    let source = ids, target = scratch;
    for (let shift = 0; shift < 32; shift += 8) {
      buckets.fill(0);
      for (let i = 0; i < leafCount; i++) { buckets[(codes[source[i]] >>> shift) & 255]++; if (work.shouldYield()) await work.yield(); }
      let sum = 0;
      for (let i = 0; i < 256; i++) { const count = buckets[i]; buckets[i] = sum; sum += count; }
      for (let i = 0; i < leafCount; i++) { const id = source[i]; target[buckets[(codes[id] >>> shift) & 255]++] = id; if (work.shouldYield()) await work.yield(); }
      [source, target] = [target, source];
    }
    const treeBounds = new Float64Array(nodes * 4), maxRanks = new Uint32Array(nodes);
    for (let leaf = 0; leaf < leafCount; leaf++) {
      const id = ids[leaf];
      treeBounds.set(rawBounds.subarray(id * 4, id * 4 + 4), leaf * 4); maxRanks[leaf] = ranks[id];
      if (work.shouldYield()) await work.yield();
    }
    for (let level = 1; level < levels.length; level++) {
      for (let i = 0; i < sizes[level]; i++) {
        const node = levels[level] + i, left = levels[level - 1] + i * 2;
        const right = Math.min(left + 1, levels[level - 1] + sizes[level - 1] - 1);
        for (let axis = 0; axis < 4; axis++) treeBounds[node * 4 + axis] = (axis < 2 ? Math.min : Math.max)(treeBounds[left * 4 + axis], treeBounds[right * 4 + axis]);
        maxRanks[node] = Math.max(maxRanks[left], maxRanks[right]);
        if (work.shouldYield()) await work.yield();
      }
    }
    this.index = { ids, bounds: treeBounds, ranks, maxRanks, levels, sizes, offsets, groupSize, total, runRanks };
    this.reportBuildProgress(100);
  }

  private reportBuildProgress(percentage: number | null): void {
    if (this.disposed) return;
    // UI observers must not invalidate an otherwise usable picking index.
    try { this.onBuildProgress?.(percentage); } catch { /* Progress is advisory. */ }
  }

  private async hit(ref: PrimitiveRef, options: ScenePrimitivePickOptions, tolerance: number, work: Work): Promise<PrimitiveHit | null> {
    const scene = this.scene, i = ref.index * 4;
    const clip = getPrimitiveClipChain(scene, ref);
    // Tolerance does not permit picking through a hard clip boundary.
    if (!withinClips(scene, options.point, clip.clipIndex, clip.rect)) return null;
    if (ref.kind === "raster") {
      if (rasterAlpha(scene, ref.index, options.point) > ALPHA_EPSILON)
        return { primitive: { ...ref }, point: { ...options.point }, closestPoint: { ...options.point }, distancePx: 0 };
      const uv = inverse(options.point, scene.rasterLayers[ref.index].matrix);
      // A transparent pixel inside the layer must not become a rectangle hit.
      if (!uv || (uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1)) return null;
      const quad = rasterQuad(scene, ref.index);
      let nearest: Nearest | null = null;
      for (let j = 0; j < 4; j++) {
        const candidate = await nearestProjected({ start: quad[j], end: quad[(j + 1) % 4] }, options, work);
        if (candidate && (!nearest || candidate.distance < nearest.distance)) nearest = candidate;
      }
      if (!nearest || nearest.distance > tolerance || rasterAlpha(scene, ref.index, nearest.point) <= ALPHA_EPSILON ||
          !withinClips(scene, nearest.point, clip.clipIndex, clip.rect)) return null;
      return { primitive: { ...ref }, point: { ...options.point }, closestPoint: nearest.point, distancePx: nearest.distance };
    }
    const store = segmentStore(scene, ref), stroke = ref.kind === "stroke" || ref.kind === "gradient-stroke";
    let alpha = 1, evenodd = false, source = -1, mask = -1;
    if (ref.kind === "text") alpha = scene.textInstanceC[i + 3];
    if (ref.kind === "fill" || ref.kind === "gradient-fill") {
      const c = ref.kind === "fill" ? scene.fillPathMetaC : scene.gradientFillPathMetaC;
      alpha = c[i + 3]; evenodd = c[i] >= 0.5;
    }
    if (ref.kind === "gradient-fill") { source = scene.gradientFillPaintMeta[i]; mask = scene.gradientFillPaintMeta[i + 1]; }
    if (ref.kind === "gradient-stroke") { source = scene.gradientStrokeRunMetaA[i + 2]; mask = scene.gradientStrokeRunMetaA[i + 3]; }
    if (alpha <= ALPHA_EPSILON) return null;
    let winding = 0, nearest: Nearest | null = null, nearestIndex = -1;
    for (let j = 0; j < store.count; j++) {
      const segment = readSegment(store, j);
      if (!stroke) winding += segmentWinding(segment, options.point);
      const candidate = await nearestProjected(segment, options, work);
      if (candidate) {
        let distance = candidate.distance;
        let visiblePoint = candidate.point, memberRect = clip.rect, memberAlpha = alpha;
        if (stroke) {
          const offset = (store.first + j) * 4, encoded = store.b[offset + 3];
          const styles = ref.kind === "stroke" ? scene.styles : scene.gradientStrokeStyles;
          const rect = ref.kind === "gradient-stroke" ? strokeClip(scene.gradientStrokePrimitiveMeta, scene.gradientStrokePrimitiveBounds, store.first + j) : clip.rect;
          memberRect = rect; memberAlpha = styleAlpha(encoded);
          if (styleAlpha(encoded) <= ALPHA_EPSILON || (rect && !inBounds(options.point, rect))) { if (work.shouldYield()) await work.yield(); continue; }
          const degenerate = Math.hypot(segment.start.x - segment.end.x, segment.start.y - segment.end.y) < 1e-8 &&
            (!segment.control || Math.hypot(segment.start.x - segment.control.x, segment.start.y - segment.control.y) < 1e-8);
          if (degenerate && (styleFlags(encoded) & 2) === 0) { if (work.shouldYield()) await work.yield(); continue; }
          if ((styleFlags(encoded) & 1) === 0) {
            const footprint = await nearestStrokeFootprint(segment, Math.max(0, styles[offset]), options, work, candidate);
            if (!footprint) { if (work.shouldYield()) await work.yield(); continue; }
            distance = footprint.distance; visiblePoint = footprint.point;
          } else {
            distance = Math.max(0, distance - 0.5);
            if (distance === 0) visiblePoint = options.point;
            else if (candidate.distance > 0) {
              const center = options.project(candidate.point);
              if (center) visiblePoint = options.unproject({
                x: center.x + (options.clientPoint.x - center.x) * 0.5 / candidate.distance,
                y: center.y + (options.clientPoint.y - center.y) * 0.5 / candidate.distance
              }) ?? candidate.point;
            }
          }
        }
        if (withinClips(scene, visiblePoint, clip.clipIndex, memberRect) &&
            memberAlpha * gradientAlpha(scene, source, visiblePoint) * gradientAlpha(scene, mask, visiblePoint) > ALPHA_EPSILON &&
            (!nearest || distance < nearest.distance)) {
          nearest = { point: withinClips(scene, candidate.point, clip.clipIndex, memberRect) ? candidate.point : visiblePoint, distance };
          nearestIndex = j;
        }
      }
      if (work.shouldYield()) await work.yield();
    }
    const inside = !stroke && (evenodd ? Math.abs(winding) % 2 === 1 : winding !== 0);
    if (inside && alpha * gradientAlpha(scene, source, options.point) * gradientAlpha(scene, mask, options.point) > ALPHA_EPSILON)
      return { primitive: { ...ref }, point: { ...options.point }, closestPoint: { ...options.point }, distancePx: 0 };
    if (!nearest || nearest.distance > tolerance + 1e-7) return null;
    return { primitive: { ...ref }, point: { ...options.point }, closestPoint: nearest.point, distancePx: nearest.distance, segmentIndex: nearestIndex };
  }
}
