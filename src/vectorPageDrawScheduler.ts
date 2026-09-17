import type { VectorScene } from "./pdfVectorExtractor";
import { VectorDrawRunCuller } from "./vectorDrawRunCulling";

const kinds = ["stroke", "fill", "text", "raster", "gradient-fill", "gradient-stroke"] as const;
const PAINT_LOOKAHEAD = 32;

/** Interleave independent paint streams; overlapping streams retain source order. */
export class VectorPageDrawScheduler {
  independentGroups = 1;
  private readonly bounds: VectorDrawRunCuller;
  private readonly pageForRun: Uint16Array;
  private readonly kindForRun: Uint8Array;
  private readonly components: Int32Array;
  private readonly pageBounds: Float64Array;
  private readonly paintBounds: Float64Array;
  private readonly heads: Int32Array;
  private readonly tails: Int32Array;
  private readonly next: Int32Array;
  private readonly ordered: number[] = [];
  private readonly compacted: number[] = [];
  private readonly skipped = new Int32Array(PAINT_LOOKAHEAD);
  private padding = NaN;
  private enabled = false;

  static create(scene: VectorScene, strokes: VectorScene, sourceRuns: Uint32Array): VectorPageDrawScheduler | null {
    const pages = scene.pageRects.length / 4;
    // Bound setup work for arbitrary public scenes, including invalid layouts.
    if (!scene.drawRuns || pages < 1 || pages > 512 || !Number.isInteger(pages) ||
        !scene.pageRects.every(Number.isFinite)) return null;
    return new VectorPageDrawScheduler(scene, strokes, sourceRuns);
  }

  private constructor(scene: VectorScene, strokes: VectorScene, sourceRuns: Uint32Array) {
    const runs = scene.drawRuns!;
    const pages = scene.pageRects.length / 4;
    this.bounds = new VectorDrawRunCuller(scene, { scene: strokes, sourceRuns });
    this.pageForRun = new Uint16Array(runs.length);
    this.kindForRun = new Uint8Array(runs.length);
    this.components = new Int32Array(pages);
    this.pageBounds = new Float64Array(pages * 4);
    this.paintBounds = new Float64Array(runs.length * 4);
    this.heads = new Int32Array(pages);
    this.tails = new Int32Array(pages);
    this.next = new Int32Array(runs.length);
    const box = [0, 0, 0, 0];
    runs.forEach((run, index) => {
      this.kindForRun[index] = kinds.indexOf(run.kind);
      this.bounds.getBounds(index, 0, box);
      const x = (box[0] + box[2]) * 0.5, y = (box[1] + box[3]) * 0.5;
      let nearest = 0, distance = Infinity;
      for (let page = 0; page < pages; page++) {
        const offset = page * 4, rect = scene.pageRects;
        const dx = Math.max(rect[offset] - x, 0, x - rect[offset + 2]);
        const dy = Math.max(rect[offset + 1] - y, 0, y - rect[offset + 3]);
        if (dx * dx + dy * dy < distance) { nearest = page; distance = dx * dx + dy * dy; }
      }
      // Page proximity is only a partitioning hint. Safety comes from the
      // actual paint bounds below, including content outside the page rect.
      this.pageForRun[index] = nearest;
    });
  }

  /** null disables reordering for projections without a conservative pixel scale. */
  updateScale(unitsPerPixel: number | null): boolean {
    if (unitsPerPixel === null || !Number.isFinite(unitsPerPixel) || unitsPerPixel <= 0) {
      const changed = this.enabled;
      this.enabled = false;
      this.independentGroups = 1;
      return changed;
    }
    // A power-of-two upper bound avoids rebuilding the dependency partition
    // on every animated zoom step. Four pixels cover analytic AA and hairlines.
    const padding = Math.max(0.001, 4 * 2 ** Math.ceil(Math.log2(Math.max(1e-6, unitsPerPixel))));
    if (this.enabled && padding === this.padding) return false;
    this.enabled = true;
    this.padding = padding;
    const pages = this.components.length;
    for (let page = 0; page < pages; page++) this.pageBounds.set([Infinity, Infinity, -Infinity, -Infinity], page * 4);
    const box = [0, 0, 0, 0];
    for (let run = 0; run < this.pageForRun.length; run++) {
      this.bounds.getBounds(run, padding, box);
      if (box.some(Number.isNaN)) box.splice(0, 4, -Infinity, -Infinity, Infinity, Infinity);
      this.paintBounds.set(box, run * 4);
      if (box[0] > box[2] || box[1] > box[3]) continue;
      const offset = this.pageForRun[run] * 4;
      this.pageBounds[offset] = Math.min(this.pageBounds[offset], box[0]);
      this.pageBounds[offset + 1] = Math.min(this.pageBounds[offset + 1], box[1]);
      this.pageBounds[offset + 2] = Math.max(this.pageBounds[offset + 2], box[2]);
      this.pageBounds[offset + 3] = Math.max(this.pageBounds[offset + 3], box[3]);
    }
    const parents = Int32Array.from({ length: pages }, (_, index) => index);
    const root = (index: number): number => {
      while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
      return index;
    };
    for (let page = 0; page < pages; page++) {
      const a = page * 4, bounds = this.pageBounds;
      if (bounds[a] > bounds[a + 2] || bounds[a + 1] > bounds[a + 3]) continue;
      for (let other = 0; other < page; other++) {
        const b = other * 4;
        if (bounds[b] > bounds[b + 2] || bounds[b + 1] > bounds[b + 3] ||
            bounds[a + 2] < bounds[b] || bounds[b + 2] < bounds[a] ||
            bounds[a + 3] < bounds[b + 1] || bounds[b + 3] < bounds[a + 1]) continue;
        const first = root(page), second = root(other);
        parents[Math.max(first, second)] = Math.min(first, second);
      }
    }
    const groups = new Set<number>();
    for (let page = 0; page < pages; page++) {
      const group = root(page);
      this.components[page] = group;
      groups.add(group);
    }
    this.independentGroups = groups.size;
    // Within-page swaps depend on paint extents even when page groups stay
    // unchanged. Replan once per AA bucket, including when zooming back in.
    return true;
  }

  schedule(runs: readonly number[]): readonly number[] {
    if (!this.enabled) return runs;
    if (this.independentGroups <= 1) return this.compact(runs);
    this.heads.fill(-1); this.tails.fill(-1); this.ordered.length = 0;
    for (const run of runs) {
      const group = this.components[this.pageForRun[run]];
      if (this.tails[group] < 0) this.heads[group] = run;
      else this.next[this.tails[group]] = run;
      this.tails[group] = run;
      this.next[run] = -1;
    }
    const votes = new Uint32Array(kinds.length);
    while (this.ordered.length < runs.length) {
      votes.fill(0);
      for (const head of this.heads) if (head >= 0) votes[this.kindForRun[head]]++;
      let kind = 0;
      for (let index = 1; index < votes.length; index++) if (votes[index] > votes[kind]) kind = index;
      for (let group = 0; group < this.heads.length; group++) {
        let head = this.heads[group];
        while (head >= 0 && this.kindForRun[head] === kind) {
          this.ordered.push(head); head = this.next[head];
        }
        this.heads[group] = head;
      }
    }
    return this.compact(this.ordered);
  }

  /** Pull matching paints forward only across paints with disjoint bounds. */
  private compact(runs: readonly number[]): readonly number[] {
    this.compacted.length = 0;
    for (let index = 0; index < runs.length; index++) this.next[runs[index]] = runs[index + 1] ?? -1;
    let head = runs[0] ?? -1;
    // Bound rebuild work when a document has many mutually overlapping paints.
    let checksLeft = Math.max(8192, runs.length * 8);
    while (head >= 0) {
      const kind = this.kindForRun[head];
      this.compacted.push(head);
      head = this.next[head];
      // Images/gradients use separate GPU resources and cannot share a draw.
      if (kind >= 3) continue;
      let cursor = head, previous = -1, skippedCount = 0;
      while (cursor >= 0 && skippedCount < PAINT_LOOKAHEAD && checksLeft > 0) {
        const following = this.next[cursor];
        let movable = this.kindForRun[cursor] === kind;
        if (movable) {
          for (let index = 0; index < skippedCount; index++) {
            if (checksLeft-- <= 0 || this.overlaps(cursor, this.skipped[index])) { movable = false; break; }
          }
        }
        if (movable) {
          this.compacted.push(cursor);
          if (previous < 0) head = following;
          else this.next[previous] = following;
        } else {
          this.skipped[skippedCount++] = cursor;
          previous = cursor;
        }
        cursor = following;
      }
    }
    return this.compacted;
  }

  private overlaps(first: number, second: number): boolean {
    const a = first * 4, b = second * 4, bounds = this.paintBounds;
    return !(bounds[a] > bounds[a + 2] || bounds[a + 1] > bounds[a + 3] ||
      bounds[b] > bounds[b + 2] || bounds[b + 1] > bounds[b + 3] ||
      bounds[a + 2] < bounds[b] || bounds[b + 2] < bounds[a] ||
      bounds[a + 3] < bounds[b + 1] || bounds[b + 3] < bounds[a + 1]);
  }
}
