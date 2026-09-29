import type { Bounds } from "./pdfVectorExtractor";

export interface StrokeIntervalPrimitive {
  paintOrder?: number;
  paintGroup?: number;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  primitiveType: number;
  halfWidth: number;
  flags: number;
  alpha: number;
  colorR: number;
  colorG: number;
  colorB: number;
  /** Exact fragment clip; only set for primitives carrying the clipped flag. */
  visibleBounds?: Bounds;
}

export interface StrokeIntervalGroup {
  paintOrder?: number;
  paintGroup?: number;
  tileIndex: number;
  axisX: number;
  axisY: number;
  normalX: number;
  normalY: number;
  offset: number;
  offsetSum: number;
  offsetWeightSum: number;
  clipMinX: number;
  clipMinY: number;
  clipMaxX: number;
  clipMaxY: number;
  halfWidth: number;
  flags: number;
  alpha: number;
  colorR: number;
  colorG: number;
  colorB: number;
  intervals: number[];
}

const STROKE_STYLE_FLAG_HAIRLINE = 1 << 0;
const STROKE_STYLE_FLAG_ROUND_CAP = 1 << 1;
const STROKE_STYLE_FLAG_CLIPPED = 1 << 2;
const ANGLE_BIN_COUNT = 720;
const ANGLE_STEP = Math.PI / ANGLE_BIN_COUNT;
const PAGE_SHIFT = 12;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;

/** Fixed-size pages avoid growing/copying a document-sized backing array. */
class PagedRecords {
  private readonly pages: Uint32Array[] = [];
  private readonly width: number;
  length = 0;

  constructor(width: number) { this.width = width; }

  append(first: number, second: number, third = 0): number {
    const index = this.length++;
    const pageIndex = index >>> PAGE_SHIFT;
    const page = this.pages[pageIndex] ?? (this.pages[pageIndex] = new Uint32Array(PAGE_SIZE * this.width));
    const offset = (index & PAGE_MASK) * this.width;
    page[offset] = first;
    page[offset + 1] = second;
    if (this.width === 3) page[offset + 2] = third;
    return index;
  }

  get(index: number, field: number): number {
    return this.pages[index >>> PAGE_SHIFT][(index & PAGE_MASK) * this.width + field];
  }

  set(index: number, field: number, value: number): void {
    this.pages[index >>> PAGE_SHIFT][(index & PAGE_MASK) * this.width + field] = value;
  }

  clear(): void {
    this.length = 0;
    // Reuse one small page across paints; release an unusually large paint's
    // remaining pages before processing the next one.
    if (this.pages.length > 1) this.pages.length = 1;
  }
}

/**
 * Retain source IDs instead of one large object and a number[] per merge group.
 * Reconstruct only the group currently being emitted. Both group insertion
 * order and member order match the original Map-based interval accumulator,
 * including the order of the weighted floating-point additions.
 */
export class CompactStrokeIntervalGroups {
  private readonly groupIds = new Map<string, number>();
  // Group: first member + 1, last member + 1, tile. Member: source ID, next + 1.
  private readonly groups = new PagedRecords(3);
  private readonly members = new PagedRecords(2);
  private readonly tolerance: number;
  private readonly overview: boolean;
  private readonly readPrimitive: (index: number) => StrokeIntervalPrimitive | null;

  constructor(tolerance: number, overview: boolean,
    readPrimitive: (index: number) => StrokeIntervalPrimitive | null) {
    this.tolerance = tolerance;
    this.overview = overview;
    this.readPrimitive = readPrimitive;
  }

  get size(): number { return this.groups.length; }

  add(primitive: StrokeIntervalPrimitive, sourceIndex: number, tileIndex: number): void {
    const key = intervalGroupKey(primitive, tileIndex, this.tolerance, this.overview);
    let groupIndex = this.groupIds.get(key);
    const memberIndex = this.members.append(sourceIndex, 0);
    if (groupIndex === undefined) {
      groupIndex = this.groups.append(memberIndex + 1, memberIndex + 1, tileIndex);
      this.groupIds.set(key, groupIndex);
    } else {
      this.members.set(this.groups.get(groupIndex, 1) - 1, 1, memberIndex + 1);
      this.groups.set(groupIndex, 1, memberIndex + 1);
    }
  }

  *values(): IterableIterator<StrokeIntervalGroup> {
    for (let groupIndex = 0; groupIndex < this.groups.length; groupIndex++) {
      const tileIndex = this.groups.get(groupIndex, 2);
      let member = this.groups.get(groupIndex, 0);
      let group: StrokeIntervalGroup | undefined;
      while (member !== 0) {
        const memberIndex = member - 1;
        const primitive = this.readPrimitive(this.members.get(memberIndex, 0));
        if (!primitive) throw new Error("LOD interval source changed during construction");
        group ??= createStrokeIntervalGroup(primitive, tileIndex, this.tolerance, this.overview);
        // The stored key already established the same snapped direction.
        // Preserve source order and each original multiply/add; rebuilding
        // keys and trigonometry for later members adds no information.
        const dx = primitive.x1 - primitive.x0;
        const dy = primitive.y1 - primitive.y0;
        const offset = primitive.x0 * group.normalX + primitive.y0 * group.normalY;
        const memberWeight = Math.hypot(dx, dy);
        group.offsetSum += offset * memberWeight;
        group.offsetWeightSum += memberWeight;
        const clip = primitive.visibleBounds;
        if (clip) {
          group.clipMinX = Math.min(group.clipMinX, clip.minX);
          group.clipMinY = Math.min(group.clipMinY, clip.minY);
          group.clipMaxX = Math.max(group.clipMaxX, clip.maxX);
          group.clipMaxY = Math.max(group.clipMaxY, clip.maxY);
        }
        pushGroupInterval(group, primitive, this.tolerance);
        member = this.members.get(memberIndex, 1);
      }
      if (group) yield group;
    }
  }

  clear(): void {
    this.groupIds.clear();
    this.groups.clear();
    this.members.clear();
  }
}

function intervalGroupKey(primitive: StrokeIntervalPrimitive, tileIndex: number, tolerance: number, overview: boolean): string {
  const dx = primitive.x1 - primitive.x0;
  const dy = primitive.y1 - primitive.y0;
  let angle = Math.atan2(dy, dx);
  if (angle < 0) {
    angle += Math.PI;
  }
  if (angle >= Math.PI) {
    angle -= Math.PI;
  }
  let angleBin = Math.round(angle / ANGLE_STEP);
  if (angleBin >= ANGLE_BIN_COUNT) {
    angleBin = 0;
  }
  const snappedAngle = angleBin * ANGLE_STEP;
  const axisX = Math.cos(snappedAngle);
  const axisY = Math.sin(snappedAngle);
  const normalX = -axisY;
  const normalY = axisX;
  const offset = primitive.x0 * normalX + primitive.y0 * normalY;
  const hairline = (primitive.flags & STROKE_STYLE_FLAG_HAIRLINE) !== 0;
  // Fine LOD bounds offset rounding by 1% of pen width to preserve hatch
  // density. Budget-oriented overview levels deliberately allow wider merges.
  const offsetStep = !overview && !hairline && primitive.halfWidth > 0
    ? Math.min(tolerance, primitive.halfWidth * 0.02) : tolerance;
  const offsetKey = Math.round(offset / offsetStep);
  const widthKey = hairline ? -1 : primitive.halfWidth;
  const colorKey =
    `${Math.round(primitive.colorR * 255)},${Math.round(primitive.colorG * 255)},` +
    `${Math.round(primitive.colorB * 255)},${Math.round(primitive.alpha * 255)}`;
  const flags = primitive.flags & (STROKE_STYLE_FLAG_HAIRLINE | STROKE_STYLE_FLAG_ROUND_CAP | STROKE_STYLE_FLAG_CLIPPED);
  // A clipped primitive's bounds are semantic fragment-clip data, not merely
  // culling bounds. Keep distinct rectangles in distinct merge groups so an
  // approximate LOD level cannot replace their intersection with a union.
  const clip = primitive.visibleBounds;
  const baseKey = `${primitive.paintGroup ?? ""}|${tileIndex}|${flags}|${widthKey}|${colorKey}|${angleBin}|${offsetKey}`;
  const key = clip
    ? `${baseKey}|clip:${clip.minX},${clip.minY},${clip.maxX},${clip.maxY}`
    : baseKey;

  return key;
}

function createStrokeIntervalGroup(
  primitive: StrokeIntervalPrimitive,
  tileIndex: number,
  tolerance: number,
  overview: boolean
): StrokeIntervalGroup {
  const dx = primitive.x1 - primitive.x0;
  const dy = primitive.y1 - primitive.y0;
  let angle = Math.atan2(dy, dx);
  if (angle < 0) {
    angle += Math.PI;
  }
  if (angle >= Math.PI) {
    angle -= Math.PI;
  }
  let angleBin = Math.round(angle / ANGLE_STEP);
  if (angleBin >= ANGLE_BIN_COUNT) {
    angleBin = 0;
  }
  const snappedAngle = angleBin * ANGLE_STEP;
  const axisX = Math.cos(snappedAngle);
  const axisY = Math.sin(snappedAngle);
  const normalX = -axisY;
  const normalY = axisX;
  const offset = primitive.x0 * normalX + primitive.y0 * normalY;
  const hairline = (primitive.flags & STROKE_STYLE_FLAG_HAIRLINE) !== 0;
  // Fine LOD bounds offset rounding by 1% of pen width to preserve hatch
  // density. Budget-oriented overview levels deliberately allow wider merges.
  const offsetStep = !overview && !hairline && primitive.halfWidth > 0
    ? Math.min(tolerance, primitive.halfWidth * 0.02) : tolerance;
  const offsetKey = Math.round(offset / offsetStep);
  const flags = primitive.flags & (STROKE_STYLE_FLAG_HAIRLINE | STROKE_STYLE_FLAG_ROUND_CAP | STROKE_STYLE_FLAG_CLIPPED);
  return {
    paintOrder: primitive.paintOrder,
    paintGroup: primitive.paintGroup,
    tileIndex,
    axisX,
    axisY,
    normalX,
    normalY,
    offset: offsetKey * offsetStep,
    offsetSum: 0,
    offsetWeightSum: 0,
    clipMinX: Number.POSITIVE_INFINITY,
    clipMinY: Number.POSITIVE_INFINITY,
    clipMaxX: Number.NEGATIVE_INFINITY,
    clipMaxY: Number.NEGATIVE_INFINITY,
    halfWidth: primitive.halfWidth,
    flags,
    alpha: primitive.alpha,
    colorR: primitive.colorR,
    colorG: primitive.colorG,
    colorB: primitive.colorB,
    intervals: []
  };
}

function pushGroupInterval(group: StrokeIntervalGroup, primitive: StrokeIntervalPrimitive, tolerance: number): void {
  const startProjection = primitive.x0 * group.axisX + primitive.y0 * group.axisY;
  const endProjection = primitive.x1 * group.axisX + primitive.y1 * group.axisY;
  let start = Math.min(startProjection, endProjection);
  let end = Math.max(startProjection, endProjection);

  // Clipped stroke geometry keeps its full unclipped extent in the source
  // scene; trim the LOD representative to the clip window (plus a small
  // extension so caps and AA still reach the clip edge before the fragment
  // discard cuts them) instead of emitting the invisible remainder.
  const clip = primitive.visibleBounds;
  if (clip) {
    const p0 = clip.minX * group.axisX + clip.minY * group.axisY;
    const p1 = clip.minX * group.axisX + clip.maxY * group.axisY;
    const p2 = clip.maxX * group.axisX + clip.minY * group.axisY;
    const p3 = clip.maxX * group.axisX + clip.maxY * group.axisY;
    const extension = Math.max(primitive.halfWidth * 4, tolerance, 1e-3);
    start = Math.max(start, Math.min(p0, p1, p2, p3) - extension);
    end = Math.min(end, Math.max(p0, p1, p2, p3) + extension);
    if (end <= start) {
      return;
    }
  }

  group.intervals.push(start, end);
}

