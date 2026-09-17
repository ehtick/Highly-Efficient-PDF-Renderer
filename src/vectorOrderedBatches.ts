import type { VectorDrawRun, VectorScene } from "./pdfVectorExtractor";
import type { VectorStrokeLodRuntime } from "./vectorStrokeLodCore";
import { strokePaintOrigins } from "./vectorStrokePaintOrder";
import { VectorPageDrawScheduler } from "./vectorPageDrawScheduler";

/** Instanced draws retain overlapping paint order; clip roots travel with each instance. */
export class VectorOrderedBatches {
  readonly batches: VectorDrawRun[] = [];
  readonly floatInstances: Float32Array;
  readonly uintInstances: Uint32Array;
  readonly strokeScene: VectorScene;
  readonly cullingPadding: number;
  instanceCount = 0;
  private readonly runtime: VectorStrokeLodRuntime | null;
  private readonly runIndices = new Map<VectorDrawRun, number>();
  private readonly rankToId: Uint32Array;
  private readonly idToRank: Uint32Array;
  private readonly rankRun: Uint32Array;
  private readonly offsets: number[] = [];
  private readonly selectedRanks: Uint32Array;
  private readonly selectedRankBits: Uint32Array;
  private readonly selectedRankWords: Uint32Array;
  private orderedSelectedCount = 0;
  private readonly previousSelectedIds: Uint32Array;
  private previousSelectedCount = 0;
  private readonly sourceRuns: readonly VectorDrawRun[];
  private readonly runRanges: Uint32Array;
  private readonly visiblePaints: number[] = [];
  private readonly scheduler: VectorPageDrawScheduler | null;
  private previousSelectedRanks = new Uint32Array(0);
  private previousRankCount = 0;
  private previousRuns: VectorDrawRun[] = [];
  private previousRunsAreSource = false;
  private initialized = false;
  private dirty = true;

  constructor(scene: VectorScene, runtime: VectorStrokeLodRuntime | null) {
    this.runtime = runtime;
    this.cullingPadding = (runtime?.levels.at(-1)?.tolerance ?? 0) * 2;
    const runs = scene.drawRuns!;
    this.sourceRuns = runs;
    this.runRanges = new Uint32Array(runs.length * 2);
    const sourceRun = new Uint32Array(scene.segmentCount);
    runs.forEach((run, index) => {
      this.runIndices.set(run, index);
      if (run.kind === "stroke") sourceRun.fill(index, run.first, run.first + run.count);
    });
    const levels = runtime?.levels ?? [{ scene, segmentCount: scene.segmentCount }];
    let total = 0;
    for (const level of levels) { this.offsets.push(total); total += level.segmentCount; }
    // One texture store lets adjacent strokes from different tile LOD levels
    // share the same draw, in the original paint order.
    this.strokeScene = scene;
    if (runtime) {
      const combined = { ...scene, segmentCount: total };
      for (const key of ["endpoints", "primitiveMeta", "primitiveBounds", "styles"] as const) {
        combined[key] = new Float32Array(total * 4);
        levels.forEach((level, index) => combined[key].set(level.scene[key], this.offsets[index] * 4));
      }
      this.strokeScene = combined;
    }
    this.rankToId = Uint32Array.from({ length: total }, (_, index) => index);
    this.idToRank = new Uint32Array(total);
    this.rankRun = new Uint32Array(total);
    this.selectedRanks = new Uint32Array(total);
    this.selectedRankBits = new Uint32Array(Math.ceil(total / 32));
    this.selectedRankWords = new Uint32Array(Math.ceil(this.selectedRankBits.length / 32));
    this.previousSelectedIds = new Uint32Array(total);
    const origins = new Uint32Array(total);
    levels.forEach((level, index) => {
      origins.set(strokePaintOrigins(level.scene)!, this.offsets[index]);
    });
    this.rankToId.sort((a, b) => sourceRun[origins[a]] - sourceRun[origins[b]] || origins[a] - origins[b] || a - b);
    const strokeSourceRuns = new Uint32Array(total);
    this.rankToId.forEach((id, rank) => {
      this.idToRank[id] = rank;
      this.rankRun[rank] = strokeSourceRuns[id] = sourceRun[origins[id]];
    });
    this.scheduler = VectorPageDrawScheduler.create(scene, this.strokeScene, strokeSourceRuns);
    const capacity = Math.max(1, total + scene.fillPathCount + scene.textInstanceCount) * 2;
    this.floatInstances = new Float32Array(capacity);
    this.uintInstances = new Uint32Array(capacity);
  }

  invalidate(): void { this.dirty = true; }

  /** Returns true only when instance data needs uploading again. */
  update(runs: readonly VectorDrawRun[], unitsPerPixel: number | null = null): boolean {
    const orderChanged = this.scheduler?.updateScale(unitsPerPixel) ?? false;
    let sameRuns = this.initialized && runs.length === this.previousRuns.length;
    if (sameRuns && !(runs === this.sourceRuns && this.previousRunsAreSource)) {
      for (let index = 0; index < runs.length; index++) {
        if (runs[index] !== this.previousRuns[index]) { sameRuns = false; break; }
      }
    }
    if (sameRuns) this.previousRunsAreSource = runs === this.sourceRuns;
    if (!this.dirty && sameRuns && !orderChanged) return false;
    this.dirty = false;
    let selectedCount = 0;
    let sameIds = this.initialized;
    if (this.runtime) {
      this.runtime.levels.forEach((level, index) => {
        const offset = this.offsets[index];
        for (let i = 0; i < level.visibleSegmentCount; i++) {
          const id = offset + level.visibleSegmentIds[i];
          if (this.previousSelectedIds[selectedCount] !== id) sameIds = false;
          this.previousSelectedIds[selectedCount++] = id;
        }
      });
    }
    sameIds &&= selectedCount === this.previousSelectedCount;
    this.previousSelectedCount = selectedCount;
    // Camera movement changes selection, never the PDF's paint order.
    if (sameIds && sameRuns && !orderChanged) return false;
    if (!sameIds) {
      for (let index = 0; index < selectedCount; index++) {
        const rank = this.idToRank[this.previousSelectedIds[index]];
        const word = rank >>> 5;
        this.selectedRankBits[word] |= 1 << (rank & 31);
        this.selectedRankWords[word >>> 5] |= 1 << (word & 31);
      }
      // Filter the order computed at scene setup. Scanning selected bits in
      // rank order replaces comparison sorting after every LOD/culling change.
      let count = 0;
      // The second bitset skips empty words when only a small detail is visible.
      for (let group = 0; group < this.selectedRankWords.length; group++) {
        let words = this.selectedRankWords[group];
        this.selectedRankWords[group] = 0;
        while (words !== 0) {
          const word = group * 32 + 31 - Math.clz32(words & -words);
          let bits = this.selectedRankBits[word];
          this.selectedRankBits[word] = 0;
          while (bits !== 0) {
            this.selectedRanks[count++] = word * 32 + 31 - Math.clz32(bits & -bits);
            bits = (bits & (bits - 1)) >>> 0;
          }
          words = (words & (words - 1)) >>> 0;
        }
      }
      this.orderedSelectedCount = count;
    }
    selectedCount = this.orderedSelectedCount;
    let sameSelection = sameRuns && selectedCount === this.previousRankCount;
    if (sameSelection) {
      for (let index = 0; index < selectedCount; index++) {
        if (this.previousSelectedRanks[index] !== this.selectedRanks[index]) { sameSelection = false; break; }
      }
    }
    if (sameSelection && !orderChanged) return false;
    this.initialized = true;
    if (!sameRuns) {
      this.previousRuns.length = runs.length;
      for (let index = 0; index < runs.length; index++) this.previousRuns[index] = runs[index];
    }
    this.previousRunsAreSource = runs === this.sourceRuns;
    if (this.previousSelectedRanks.length < selectedCount) {
      this.previousSelectedRanks = new Uint32Array(Math.min(this.selectedRanks.length,
        Math.max(selectedCount, this.previousSelectedRanks.length * 2)));
    }
    this.previousSelectedRanks.set(this.selectedRanks.subarray(0, selectedCount));
    this.previousRankCount = selectedCount;
    this.batches.length = 0;
    this.instanceCount = 0;
    this.visiblePaints.length = 0;
    let cursor = 0;
    for (const run of runs) {
      const runIndex = this.runIndices.get(run)!;
      let first = run.first, count = run.count;
      if (run.kind === "stroke" && this.runtime) {
        while (cursor < selectedCount && this.rankRun[this.selectedRanks[cursor]] < runIndex) cursor++;
        first = cursor;
        while (cursor < selectedCount && this.rankRun[this.selectedRanks[cursor]] === runIndex) cursor++;
        count = cursor - first;
      }
      if (count === 0) continue;
      this.runRanges[runIndex * 2] = first;
      this.runRanges[runIndex * 2 + 1] = count;
      this.visiblePaints.push(runIndex);
    }
    // Schedule paint ranges first, then write selected instances directly in
    // final order. No intermediate instance copy or per-run array views.
    for (const runIndex of this.scheduler?.schedule(this.visiblePaints) ?? this.visiblePaints) {
      const run = this.sourceRuns[runIndex];
      const start = this.runRanges[runIndex * 2], count = this.runRanges[runIndex * 2 + 1];
      if (run.kind !== "stroke" && run.kind !== "fill" && run.kind !== "text") {
        this.batches.push({ ...run });
        continue;
      }
      const first = this.instanceCount;
      if (run.kind === "stroke" && this.runtime) {
        for (let index = start; index < start + count; index++) {
          this.appendInstance(run, this.rankToId[this.selectedRanks[index]]);
        }
      } else {
        for (let id = start; id < start + count; id++) this.appendInstance(run, id);
      }
      const previous = this.batches[this.batches.length - 1];
      if (previous?.kind === run.kind && previous.clipIndex === -2) previous.count += count;
      else this.batches.push({ kind: run.kind, first, count, clipIndex: -2 });
    }
    this.floatInstances.set(this.uintInstances.subarray(0, this.instanceCount * 2));
    return true;
  }

  private appendInstance(run: VectorDrawRun, id: number): void {
    const offset = this.instanceCount * 2;
    this.uintInstances[offset] = id;
    this.uintInstances[offset + 1] = (run.clipIndex ?? -1) + 1;
    this.instanceCount++;
  }
}
