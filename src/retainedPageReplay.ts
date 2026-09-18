import type { HeprPageData } from "./heprDocumentData";
import type { OptionalContentSnapshot } from "./optionalContent";
import type { RasterLayer, VectorScene } from "./pdfVectorExtractor";
import type { SceneRetainedPage } from "./retainedPageData";
import { planScenePaintPasses, type ScenePaintNode, type ScenePaintRetained } from "./scenePaintGraph";
import { waitForLoad } from "./loadCancellation";

/** Change only the executor's visibility bytes, retaining all immutable geometry/resources. */
export function applyRetainedPageVisibility(resource: SceneRetainedPage, snapshot: OptionalContentSnapshot): HeprPageData {
  const original = resource.page.stores.optionalContent;
  const defaultVisible = new Uint8Array(original.defaultVisible.length);
  if (resource.optionalContentConditions.length !== defaultVisible.length) throw new RangeError("Retained visibility map has an invalid length.");
  for (let index = 0; index < defaultVisible.length; index++) {
    const condition = resource.optionalContentConditions[index];
    if (condition < -1 || condition >= snapshot.conditions.length) throw new RangeError("Retained visibility map references an unknown condition.");
    defaultVisible[index] = condition < 0 || snapshot.conditions[condition] !== 0 ? 1 : 0;
  }
  return { ...resource.page, stores: { ...resource.page.stores, optionalContent: { ...original, defaultVisible } } };
}

type RenderSpan = (page: HeprPageData, first: number, count: number, signal: AbortSignal) => Promise<RasterLayer | null>;
export interface RetainedPageReplayResult {
  readonly layers: ReadonlyMap<number, RasterLayer>;
  /** Adopt the prepared cache only after the view has accepted its resource replacements. */
  commit(): void;
}

/** View-owned replay cache. Loading HEP does not require the source PDF or an active PDF session. */
export class RetainedPageReplay {
  private readonly scene: VectorScene;
  private readonly nodes: ScenePaintRetained[] = [];
  private readonly renderSpan: RenderSpan;
  private layers = new Map<number, RasterLayer>();
  private pageVisibility: Uint8Array[];
  private visible = new Set<number>();
  private generation = 0;
  private disposed = false;

  constructor(scene: VectorScene, renderSpan?: RenderSpan) {
    this.scene = scene;
    this.renderSpan = renderSpan ?? (async (page, first, count, signal) => {
      const { renderNativeRetainedCommandSpan } = await import("./pdfSession");
      return renderNativeRetainedCommandSpan(page, first, count, signal);
    });
    const collect = (nodes: readonly ScenePaintNode[]): void => {
      for (const node of nodes) if (node.kind === "retained") {
        this.nodes.push(node); this.layers.set(node.rasterIndex, scene.rasterLayers[node.rasterIndex]);
      } else if (node.kind === "group") { collect(node.children); if (node.softMask) collect(node.softMask.children); }
    };
    if (scene.paintGraph) collect(scene.paintGraph.roots);
    this.pageVisibility = scene.retainedPages?.map(resource => resource.page.stores.optionalContent.defaultVisible.slice()) ?? [];
    // Initial slots already represent parser-provided defaults; unknown initial graph visibility
    // is deliberately replayed once before a view presents its first changed configuration.
  }
  getLayers(): ReadonlyMap<number, RasterLayer> { return new Map(this.layers); }
  async prepare(snapshot: OptionalContentSnapshot, options: {
    readonly signal: AbortSignal;
    readonly onProgress?: (percentage: number | null) => void;
  }): Promise<RetainedPageReplayResult> {
    if (this.disposed) throw new Error("Retained page replay has been disposed.");
    options.signal.throwIfAborted();
    const generation = ++this.generation;
    const layers = new Map(this.layers);
    const pages = this.scene.retainedPages?.map(resource => applyRetainedPageVisibility(resource, snapshot)) ?? [];
    const pageVisibility = pages.map(page => page.stores.optionalContent.defaultVisible);
    const changed = pageVisibility.map((bits, index) => bits.length !== this.pageVisibility[index]?.length ||
      bits.some((bit, offset) => bit !== this.pageVisibility[index][offset]));
    const visible = new Set(planScenePaintPasses(this.scene, condition => condition === undefined || snapshot.conditions[condition] !== 0)
      .filter(pass => pass.kind === "retained").map(pass => pass.kind === "retained" ? pass.node.rasterIndex : -1));
    const report = (value: number | null): void => {
      if (generation !== this.generation || this.disposed) return;
      try { options.onProgress?.(value); } catch { /* Observers do not own replay. */ }
    };
    report(0);
    try {
      for (let index = 0; index < this.nodes.length; index++) {
        options.signal.throwIfAborted();
        const node = this.nodes[index], original = this.scene.rasterLayers[node.rasterIndex];
        if (!visible.has(node.rasterIndex)) {
          layers.set(node.rasterIndex, { ...original, width: 1, height: 1, data: new Uint8Array(4) });
        } else if (changed[node.retainedPage] || !this.visible.has(node.rasterIndex)) {
          await waitForLoad(new Promise<void>(resolve => setTimeout(resolve, 0)), options.signal);
          const rendered = await waitForLoad(this.renderSpan(pages[node.retainedPage], node.firstCommand, node.count, options.signal), options.signal);
          options.signal.throwIfAborted();
          if (rendered) {
            const a = this.scene.retainedPages![node.retainedPage].matrix, b = rendered.matrix;
            const matrix = new Float32Array([a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
              a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
              a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]);
            layers.set(node.rasterIndex, { ...rendered, matrix, paintOrder: original.paintOrder, pageIndex: original.pageIndex });
          } else layers.set(node.rasterIndex, { ...original, width: 1, height: 1, data: new Uint8Array(4) });
        }
        report(Math.floor((index + 1) / this.nodes.length * 100));
      }
      return { layers, commit: () => {
        options.signal.throwIfAborted();
        if (this.disposed || generation !== this.generation) throw new DOMException("Retained replay superseded.", "AbortError");
        this.layers = layers; this.pageVisibility = pageVisibility; this.visible = visible;
      } };
    } finally { report(null); }
  }
  dispose(): void { this.disposed = true; this.generation++; this.layers.clear(); this.visible.clear(); this.pageVisibility = []; }
}
