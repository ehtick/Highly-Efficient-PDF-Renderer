import { VectorDrawRunCuller } from "./vectorDrawRunCulling";
import type { Bounds, VectorDrawRun, VectorScene } from "./pdfVectorExtractor";
import type { PrimitiveKind, PrimitiveRef } from "./scenePrimitives";
import type { ScenePaintNode } from "./scenePaintGraph";
import { defaultVectorDrawRuns, validateVectorDrawRuns } from "./vectorDrawOrder";
import { validateScenePaintGraph } from "./scenePaintGraph";

export const PAGE_PRIMITIVE_KINDS = ["stroke", "fill", "text", "raster", "gradient-fill", "gradient-stroke"] as const;
export const PAGE_PRIMITIVE_RANGE_STRIDE = PAGE_PRIMITIVE_KINDS.length * 2;
export function scenePrimitiveCounts(scene: VectorScene): Record<PrimitiveKind, number> {
  return { stroke: scene.segmentCount, fill: scene.fillPathCount, text: scene.textInstanceCount,
    raster: scene.rasterLayers.length, "gradient-fill": scene.gradientFillPathCount,
    "gradient-stroke": scene.gradientStrokeRunCount };
}

/** Complete, ordered per-page [first,count] pairs for each PAGE_PRIMITIVE_KINDS store. */
export function validatePagePrimitiveRanges(scene: VectorScene): void {
  const ranges = scene.pagePrimitiveRanges;
  if (ranges === undefined) return;
  const pages = scene.pageRects.length / 4, counts = scenePrimitiveCounts(scene);
  if (!(ranges instanceof Uint32Array) || ranges.length !== pages * PAGE_PRIMITIVE_RANGE_STRIDE)
    throw new RangeError("Invalid page primitive ranges.");
  PAGE_PRIMITIVE_KINDS.forEach((kind, k) => {
    let next = 0;
    for (let page = 0; page < pages; page++) {
      const offset = page * PAGE_PRIMITIVE_RANGE_STRIDE + k * 2;
      if (ranges[offset] !== next || ranges[offset + 1] > counts[kind] - next)
        throw new RangeError("Page primitive ranges overlap, omit, or exceed their store.");
      next += ranges[offset + 1];
    }
    if (next !== counts[kind]) throw new RangeError("Page primitive ranges do not cover their store.");
  });
}

export interface ScenePageView {
  scene: VectorScene;
  /** Paint extents without the background, for transformed-page depth safety. */
  paintBounds: Bounds;
  /** Local primitive index -> canonical document primitive index. */
  primitives: Record<PrimitiveKind, Uint32Array>;
  pageIndex: number;
}

/** Partition once. Older HEP files need spatial inference for strokes and fills. */
export class ScenePageViews {
  readonly pageCount: number;
  readonly owners: Record<PrimitiveKind, Uint32Array>;
  private readonly indices: Record<PrimitiveKind, number[][]>;
  readonly scene: VectorScene;
  constructor(scene: VectorScene) {
    this.scene = scene;
    this.pageCount = Math.floor(scene.pageRects.length / 4);
    if (this.pageCount < 1) throw new RangeError("The scene has no pages.");
    validatePagePrimitiveRanges(scene);
    const counts = scenePrimitiveCounts(scene);
    this.owners = {} as Record<PrimitiveKind, Uint32Array>;
    this.indices = {} as Record<PrimitiveKind, number[][]>;
    let inferred = false;
    for (const [k, kind] of PAGE_PRIMITIVE_KINDS.entries()) {
      const owners = this.owners[kind] = new Uint32Array(counts[kind]);
      const indices = this.indices[kind] = Array.from({ length: this.pageCount }, () => [] as number[]);
      if (scene.pagePrimitiveRanges) {
        for (let page = 0; page < this.pageCount; page++) {
          const offset = page * PAGE_PRIMITIVE_RANGE_STRIDE + k * 2;
          owners.fill(page, scene.pagePrimitiveRanges[offset], scene.pagePrimitiveRanges[offset] + scene.pagePrimitiveRanges[offset + 1]);
        }
      } else if (kind === "text") {
        for (let page = 0; page < this.pageCount; page++)
          owners.fill(page, scene.pageTextRanges[page * 2], scene.pageTextRanges[page * 2] + scene.pageTextRanges[page * 2 + 1]);
      } else for (let index = 0; index < counts[kind]; index++) {
        if (kind === "raster") owners[index] = scene.rasterLayers[index].pageIndex ?? 0;
        else if (kind === "gradient-fill") owners[index] = scene.gradientFillPaintMeta[index * 4 + 3];
        else if (kind === "gradient-stroke") owners[index] = scene.gradientStrokeRunMetaB[index * 4 + 1];
        else if (this.pageCount > 1) {
          inferred = true;
          const i = index * 4;
          owners[index] = kind === "stroke"
            ? this.pageAt((scene.primitiveBounds[i] + scene.primitiveBounds[i + 2]) / 2,
              (scene.primitiveBounds[i + 1] + scene.primitiveBounds[i + 3]) / 2)
            : this.pageAt((scene.fillPathMetaA[i + 2] + scene.fillPathMetaB[i]) / 2,
              (scene.fillPathMetaA[i + 3] + scene.fillPathMetaB[i + 1]) / 2);
        }
      }
      for (let index = 0; index < owners.length; index++) {
        if (owners[index] >= this.pageCount) throw new RangeError("Primitive references an unknown page.");
        indices[owners[index]].push(index);
      }
    }
    if (inferred) console.warn("[HEPR] This scene has no exact page primitive ranges. Independent page views infer stroke/fill ownership from the original layout; out-of-page or overlapping content may be assigned approximately.");
  }

  pageAt(x: number, y: number): number {
    let nearest = 0, distance = Infinity;
    for (let page = 0; page < this.pageCount; page++) {
      const r = this.scene.pageRects, i = page * 4;
      const dx = Math.max(Math.min(r[i], r[i + 2]) - x, 0, x - Math.max(r[i], r[i + 2]));
      const dy = Math.max(Math.min(r[i + 1], r[i + 3]) - y, 0, y - Math.max(r[i + 1], r[i + 3]));
      const d = dx * dx + dy * dy;
      if (d < distance) { nearest = page; distance = d; }
    }
    return nearest;
  }

  extract(pageIndex: number): ScenePageView {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) throw new RangeError("Invalid page index.");
    const source = this.scene;
    const primitives = Object.fromEntries(PAGE_PRIMITIVE_KINDS.map(kind => [kind, Uint32Array.from(this.indices[kind][pageIndex])])) as Record<PrimitiveKind, Uint32Array>;
    const maps = Object.fromEntries(PAGE_PRIMITIVE_KINDS.map(kind => [kind,
      new Map(Array.from(primitives[kind], (index, local) => [index, local]))])) as Record<PrimitiveKind, Map<number, number>>;
    const scene: VectorScene = { ...source, pageCount: 1, pagesPerRow: 1,
      pageRects: source.pageRects.slice(pageIndex * 4, pageIndex * 4 + 4), pagePrimitiveRanges: undefined,
      textIndex: null, retainedPages: undefined, paintGraph: undefined, clipPaths: undefined };
    const r = scene.pageRects;
    scene.pageBounds = { minX: Math.min(r[0], r[2]), minY: Math.min(r[1], r[3]), maxX: Math.max(r[0], r[2]), maxY: Math.max(r[1], r[3]) };
    scene.bounds = { ...scene.pageBounds };
    const take = (key: keyof VectorScene, indices: ArrayLike<number>, stride = 4): Float32Array => {
      const data = source[key] as Float32Array, result = new Float32Array(indices.length * stride);
      for (let i = 0; i < indices.length; i++) result.set(data.subarray(indices[i] * stride, (indices[i] + 1) * stride), i * stride);
      return result;
    };
    for (const key of ["endpoints", "primitiveMeta", "primitiveBounds", "styles"] as const) scene[key] = take(key, primitives.stroke);
    scene.segmentCount = scene.sourceSegmentCount = scene.mergedSegmentCount = primitives.stroke.length;
    scene.maxHalfWidth = 0;
    for (let i = 0; i < scene.styles.length; i += 4) scene.maxHalfWidth = Math.max(scene.maxHalfWidth, scene.styles[i]);

    const compactPaths = (ids: Uint32Array, metaKey: "fillPathMetaA" | "gradientFillPathMetaA", aKey: "fillSegmentsA" | "gradientFillSegmentsA", bKey: "fillSegmentsB" | "gradientFillSegmentsB") => {
      const meta = take(metaKey, ids), segments: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const first = meta[i * 4], count = meta[i * 4 + 1];
        meta[i * 4] = segments.length;
        for (let j = 0; j < count; j++) segments.push(first + j);
      }
      scene[metaKey] = meta; scene[aKey] = take(aKey, segments); scene[bKey] = take(bKey, segments);
      return segments.length;
    };
    scene.fillPathCount = primitives.fill.length;
    scene.fillSegmentCount = compactPaths(primitives.fill, "fillPathMetaA", "fillSegmentsA", "fillSegmentsB");
    scene.fillPathMetaB = take("fillPathMetaB", primitives.fill); scene.fillPathMetaC = take("fillPathMetaC", primitives.fill);
    scene.gradientFillPathCount = primitives["gradient-fill"].length;
    scene.gradientFillSegmentCount = compactPaths(primitives["gradient-fill"], "gradientFillPathMetaA", "gradientFillSegmentsA", "gradientFillSegmentsB");
    for (const key of ["gradientFillPathMetaB", "gradientFillPathMetaC", "gradientFillPaintMeta"] as const) scene[key] = take(key, primitives["gradient-fill"]);
    scene.gradientStrokeRunCount = primitives["gradient-stroke"].length;
    scene.gradientStrokeRunMetaA = take("gradientStrokeRunMetaA", primitives["gradient-stroke"]);
    scene.gradientStrokeRunMetaB = take("gradientStrokeRunMetaB", primitives["gradient-stroke"]);
    const gradientSegments: number[] = [];
    for (let i = 0; i < scene.gradientStrokeRunCount; i++) {
      const first = scene.gradientStrokeRunMetaA[i * 4], count = scene.gradientStrokeRunMetaA[i * 4 + 1];
      scene.gradientStrokeRunMetaA[i * 4] = gradientSegments.length;
      scene.gradientStrokeRunMetaB[i * 4 + 1] = 0;
      for (let j = 0; j < count; j++) gradientSegments.push(first + j);
    }
    scene.gradientStrokeSegmentCount = gradientSegments.length;
    for (const key of ["gradientStrokeEndpoints", "gradientStrokePrimitiveMeta", "gradientStrokePrimitiveBounds", "gradientStrokeStyles"] as const) scene[key] = take(key, gradientSegments);
    const gradients: number[] = [], gradientMap = new Map<number, number>();
    const gradient = (index: number): number => {
      if (index < 0) return -1;
      if (!gradientMap.has(index)) { gradientMap.set(index, gradients.length); gradients.push(index); }
      return gradientMap.get(index)!;
    };
    for (let i = 0; i < scene.gradientFillPaintMeta.length; i += 4) {
      scene.gradientFillPaintMeta[i] = gradient(scene.gradientFillPaintMeta[i]);
      scene.gradientFillPaintMeta[i + 1] = gradient(scene.gradientFillPaintMeta[i + 1]); scene.gradientFillPaintMeta[i + 3] = 0;
    }
    for (let i = 0; i < scene.gradientStrokeRunMetaA.length; i += 4) {
      scene.gradientStrokeRunMetaA[i + 2] = gradient(scene.gradientStrokeRunMetaA[i + 2]);
      scene.gradientStrokeRunMetaA[i + 3] = gradient(scene.gradientStrokeRunMetaA[i + 3]);
    }
    scene.gradientCount = gradients.length;
    for (const key of ["gradientMetaA", "gradientMetaB", "gradientMetaC", "gradientMetaD", "gradientMetaE"] as const) scene[key] = take(key, gradients);
    const lutStride = source.gradientCount ? source.gradientLut.length / source.gradientCount : 0;
    scene.gradientLut = new Uint8Array(gradients.length * lutStride);
    gradients.forEach((id, index) => scene.gradientLut.set(source.gradientLut.subarray(id * lutStride, (id + 1) * lutStride), index * lutStride));
    compactGradientMeshes(source, scene, gradients);

    scene.textInstanceCount = scene.sourceTextCount = scene.textInPageCount = primitives.text.length; scene.textOutOfPageCount = 0;
    scene.textInstanceA = take("textInstanceA", primitives.text); scene.textInstanceB = take("textInstanceB", primitives.text); scene.textInstanceC = take("textInstanceC", primitives.text);
    const glyphs: number[] = [], glyphMap = new Map<number, number>(), textClips: number[] = [], textClipMap = new Map<number, number>();
    for (let i = 0; i < scene.textInstanceB.length; i += 4) {
      const glyph = scene.textInstanceB[i + 2];
      if (!glyphMap.has(glyph)) { glyphMap.set(glyph, glyphs.length); glyphs.push(glyph); }
      scene.textInstanceB[i + 2] = glyphMap.get(glyph)!;
      const clip = scene.textInstanceB[i + 3] - 1;
      if (clip >= 0) {
        if (!textClipMap.has(clip)) { textClipMap.set(clip, textClips.length); textClips.push(clip); }
        scene.textInstanceB[i + 3] = textClipMap.get(clip)! + 1;
      }
    }
    scene.textClipRects = textClips.length ? take("textClipRects", textClips) : undefined;
    scene.textGlyphCount = glyphs.length; scene.textGlyphMetaA = take("textGlyphMetaA", glyphs); scene.textGlyphMetaB = take("textGlyphMetaB", glyphs);
    const glyphSegments: number[] = [];
    for (let i = 0; i < glyphs.length; i++) {
      const first = scene.textGlyphMetaA[i * 4], count = scene.textGlyphMetaA[i * 4 + 1];
      scene.textGlyphMetaA[i * 4] = glyphSegments.length;
      for (let j = 0; j < count; j++) glyphSegments.push(first + j);
    }
    scene.textGlyphSegmentCount = glyphSegments.length;
    scene.textGlyphSegmentsA = take("textGlyphSegmentsA", glyphSegments); scene.textGlyphSegmentsB = take("textGlyphSegmentsB", glyphSegments);
    scene.pageTextRanges = Uint32Array.of(0, scene.textInstanceCount);
    const text = source.textIndex?.pages[pageIndex];
    if (text) scene.textIndex = { version: 2, pages: [{ ...text,
      charInstance: Int32Array.from(text.charInstance, id => id < 0 ? id : maps.text.get(id) ?? -1) }] };
    scene.textContent = source.textContent?.filter(item => item.pageIndex === pageIndex).map(item => ({ ...item, pageIndex: 0 }));
    scene.annotations = source.annotations?.filter(a => a.pageIndex === pageIndex).map(a => ({ ...a, pageIndex: 0 }));
    scene.pdfPages = source.pdfPages?.filter(p => p.pageIndex === pageIndex).map(p => ({ ...p, pageIndex: 0 }));
    scene.rasterLayers = Array.from(primitives.raster, index => ({ ...source.rasterLayers[index], pageIndex: 0 }));
    const raster = scene.rasterLayers[0];
    scene.rasterLayerWidth = raster?.width ?? 0; scene.rasterLayerHeight = raster?.height ?? 0;
    scene.rasterLayerData = raster?.data ?? new Uint8Array(0); scene.rasterLayerMatrix = raster?.matrix ?? Float32Array.of(1,0,0,1,0,0);
    scene.imagePaintOpCount = scene.rasterLayers.length;

    const runs = source.drawRuns ?? defaultVectorDrawRuns(source), runMap = new Map<number, number[]>();
    scene.drawRuns = [];
    const clipMap = new Map<number, number>(); scene.clipPaths = [];
    const clipIndex = (old: number): number => {
      if (clipMap.has(old)) return clipMap.get(old)!;
      const clip = source.clipPaths![old], parent = clip.parent < 0 ? -1 : clipIndex(clip.parent);
      const index = scene.clipPaths!.length; clipMap.set(old, index); scene.clipPaths!.push({ ...clip, parent }); return index;
    };
    runs.forEach((run, oldIndex) => {
      const ids = primitives[run.kind];
      const first = lowerBound(ids, run.first), end = lowerBound(ids, run.first + run.count);
      if (first === end) return;
      // Compaction preserves canonical store order, so any selected subset of
      // one source interval is contiguous in the compact store.
      const next: VectorDrawRun = { ...run, first, count: end - first,
        ...(run.clipIndex === undefined ? {} : { clipIndex: clipIndex(run.clipIndex) }) };
      runMap.set(oldIndex, [scene.drawRuns!.length]); scene.drawRuns!.push(next);
    });
    const retainedMap = new Map<number, number>();
    const nodes = (input: readonly ScenePaintNode[]): ScenePaintNode[] => input.flatMap((node): ScenePaintNode[] => {
      if (node.kind === "draw") return (runMap.get(node.runIndex) ?? []).map(runIndex => ({ ...node, runIndex }));
      if (node.kind === "retained") {
        const rasterIndex = maps.raster.get(node.rasterIndex); if (rasterIndex === undefined) return [];
        scene.retainedPages ??= [];
        if (!retainedMap.has(node.retainedPage)) { retainedMap.set(node.retainedPage, scene.retainedPages.length); scene.retainedPages.push(source.retainedPages![node.retainedPage]); }
        return [{ ...node, rasterIndex, retainedPage: retainedMap.get(node.retainedPage)! }];
      }
      const children = nodes(node.children); if (!children.length) return [];
      return [{ ...node, children, ...(node.softMask ? { softMask: { ...node.softMask, children: nodes(node.softMask.children) } } : {}) }];
    });
    if (source.paintGraph) scene.paintGraph = { roots: nodes(source.paintGraph.roots) };
    // Include off-page paints in culling/LOD bounds without moving the page pivot.
    const paintBounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const include = (bounds: Bounds) => {
      paintBounds.minX = Math.min(paintBounds.minX, bounds.minX); paintBounds.minY = Math.min(paintBounds.minY, bounds.minY);
      paintBounds.maxX = Math.max(paintBounds.maxX, bounds.maxX); paintBounds.maxY = Math.max(paintBounds.maxY, bounds.maxY);
      scene.bounds.minX = Math.min(scene.bounds.minX, bounds.minX); scene.bounds.minY = Math.min(scene.bounds.minY, bounds.minY);
      scene.bounds.maxX = Math.max(scene.bounds.maxX, bounds.maxX); scene.bounds.maxY = Math.max(scene.bounds.maxY, bounds.maxY); };
    const culler = new VectorDrawRunCuller(scene), box = [0, 0, 0, 0];
    for (let index = 0; index < scene.drawRuns.length; index++) {
      const kind = scene.drawRuns[index].kind;
      if (kind === "gradient-fill" || kind === "gradient-stroke") continue;
      culler.getBounds(index, 0, box);
      if (box.every(Number.isFinite) && box[0] <= box[2] && box[1] <= box[3])
        include({ minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] });
    }
    // The general draw-run culler keeps legacy gradients unbounded. Their
    // canonical geometry still supplies finite extents for page projections.
    for (let i = 0; i < scene.gradientFillPathCount * 4; i += 4) include({
      minX: scene.gradientFillPathMetaA[i + 2], minY: scene.gradientFillPathMetaA[i + 3],
      maxX: scene.gradientFillPathMetaB[i], maxY: scene.gradientFillPathMetaB[i + 1]
    });
    for (let i = 0; i < scene.gradientStrokeSegmentCount * 4; i += 4) {
      const a = scene.gradientStrokeEndpoints, b = scene.gradientStrokePrimitiveMeta;
      const margin = Math.SQRT2 * Math.max(0, scene.gradientStrokeStyles[i]);
      include({ minX: Math.min(a[i], a[i + 2], b[i]) - margin, minY: Math.min(a[i + 1], a[i + 3], b[i + 1]) - margin,
        maxX: Math.max(a[i], a[i + 2], b[i]) + margin, maxY: Math.max(a[i + 1], a[i + 3], b[i + 1]) + margin });
    }
    scene.pathCount = scene.fillPathCount + scene.gradientFillPathCount;
    scene.pagePrimitiveRanges = Uint32Array.from(PAGE_PRIMITIVE_KINDS.flatMap(kind => [0, primitives[kind].length]));
    validateVectorDrawRuns(scene); validateScenePaintGraph(scene);
    return { scene, paintBounds, primitives, pageIndex };
  }

  localRef(view: ScenePageView, ref: PrimitiveRef): PrimitiveRef | null {
    const ids = view.primitives[ref.kind];
    let lo = 0, hi = ids.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (ids[mid] < ref.index) lo = mid + 1; else hi = mid; }
    return ids[lo] === ref.index ? { kind: ref.kind, index: lo } : null;
  }
}

function compactGradientMeshes(source: VectorScene, scene: VectorScene, gradients: number[]): void {
  scene.gradientMeshRanges = undefined; scene.gradientMeshPositions = undefined; scene.gradientMeshColors = undefined; scene.gradientMeshIndices = undefined;
  if (!source.gradientMeshRanges || !source.gradientMeshIndices) return;
  const ranges = new Uint32Array(gradients.length * 2), positions: number[] = [], colors: number[] = [], indices: number[] = [], vertices = new Map<number, number>();
  gradients.forEach((gradient, local) => {
    const first = source.gradientMeshRanges![gradient * 2], count = source.gradientMeshRanges![gradient * 2 + 1];
    ranges[local * 2] = indices.length; ranges[local * 2 + 1] = count;
    for (let i = first; i < first + count; i++) {
      const vertex = source.gradientMeshIndices![i];
      if (!vertices.has(vertex)) { vertices.set(vertex, vertices.size); positions.push(...source.gradientMeshPositions!.subarray(vertex * 2, vertex * 2 + 2)); colors.push(...source.gradientMeshColors!.subarray(vertex * 4, vertex * 4 + 4)); }
      indices.push(vertices.get(vertex)!);
    }
  });
  scene.gradientMeshRanges = ranges; scene.gradientMeshPositions = Float32Array.from(positions);
  scene.gradientMeshColors = Float32Array.from(colors); scene.gradientMeshIndices = Uint32Array.from(indices);
}

function lowerBound(values: Uint32Array, value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}
