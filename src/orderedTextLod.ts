import type { VectorScene } from "./pdfVectorExtractor";
import type { TextLodBuildData, TextLodSelectionResult } from "./textLodCore";

/** Route selected exact/coarse glyphs back to their canonical PDF paint. */
export class OrderedTextLodSelection {
  readonly ranges: Uint32Array;
  instanceIds = new Uint32Array(0);
  revision = 0;
  private readonly paints: { first: number; end: number; index: number }[];
  private readonly coarsePaints: Uint32Array;
  private readonly exactCount: number;
  private readonly counts: Uint32Array;
  private readonly cursors: Uint32Array;
  private selectedPaints = new Uint32Array(0);

  constructor(scene: VectorScene, data: TextLodBuildData) {
    const runs = scene.drawRuns ?? [];
    this.paints = runs.flatMap((run, index) => run.kind === "text"
      ? [{ first: run.first, end: run.first + run.count, index }] : []).sort((a, b) => a.first - b.first);
    this.exactCount = data.exactInstanceCount;
    this.ranges = new Uint32Array(runs.length * 2);
    this.counts = new Uint32Array(runs.length);
    this.cursors = new Uint32Array(runs.length);
    this.coarsePaints = new Uint32Array(data.coarseInstanceCount);
    for (const run of data.runs) {
      if (run.coarseIndex < 0) continue;
      const paint = this.paintAt(run.exactStart);
      if (run.exactStart + run.exactCount > paint.end) throw new Error("Text LOD crosses a PDF paint boundary.");
      this.coarsePaints[run.coarseIndex] = paint.index;
    }
  }

  /** Selection is rebuilt only when the shared LOD selector changes its IDs. */
  update(selection: TextLodSelectionResult): void {
    if (this.revision && !selection.changed) return;
    const ids = selection.instanceIds;
    if (this.instanceIds.length < ids.length) {
      this.instanceIds = new Uint32Array(ids.length);
      this.selectedPaints = new Uint32Array(ids.length);
    }
    this.counts.fill(0);
    // Exact IDs arrive in source order, usually thousands from one paint.
    // Search only when leaving that paint, rather than once per glyph.
    let exactPaint = this.paints[0];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id < this.exactCount && (!exactPaint || id < exactPaint.first || id >= exactPaint.end)) {
        exactPaint = this.paintAt(id);
      }
      const paint = id < this.exactCount ? exactPaint.index : this.coarsePaints[id - this.exactCount];
      this.selectedPaints[i] = paint;
      this.counts[paint]++;
    }
    let offset = 0;
    for (let paint = 0; paint < this.counts.length; paint++) {
      this.ranges[paint * 2] = this.cursors[paint] = offset;
      this.ranges[paint * 2 + 1] = this.counts[paint];
      offset += this.counts[paint];
    }
    for (let i = 0; i < ids.length; i++) this.instanceIds[this.cursors[this.selectedPaints[i]]++] = ids[i];
    this.revision++;
  }

  private paintAt(id: number) {
    let low = 0, high = this.paints.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.paints[middle].end <= id) low = middle + 1; else high = middle;
    }
    const paint = this.paints[low];
    if (!paint || id < paint.first) throw new Error("Text LOD glyph has no PDF paint.");
    return paint;
  }
}
