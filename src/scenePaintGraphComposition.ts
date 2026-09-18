import type { ScenePaintGraph, ScenePaintNode } from "./scenePaintGraph";

/** Remap scene-local references while translating the page into its composed slot. */
export function composePagePaintGraph(graph: ScenePaintGraph, offsets: {
  readonly run: number; readonly raster: number; readonly retainedPage: number; readonly condition: number;
  readonly x: number; readonly y: number;
}): ScenePaintGraph {
  const nodes = (source: readonly ScenePaintNode[]): ScenePaintNode[] => source.map(node => {
    const scope = node.optionalContent === undefined ? {} : { optionalContent: node.optionalContent + offsets.condition };
    if (node.kind === "draw") return { ...node, ...scope, runIndex: node.runIndex + offsets.run };
    if (node.kind === "retained") return { ...node, ...scope,
      retainedPage: node.retainedPage + offsets.retainedPage, rasterIndex: node.rasterIndex + offsets.raster };
    return { ...node, ...scope, children: nodes(node.children), ...(node.bounds ? { bounds: {
      minX: node.bounds.minX + offsets.x, minY: node.bounds.minY + offsets.y,
      maxX: node.bounds.maxX + offsets.x, maxY: node.bounds.maxY + offsets.y
    } } : {}), ...(node.softMask ? { softMask: { ...node.softMask, children: nodes(node.softMask.children),
      ...(node.softMask.transfer ? { transfer: node.softMask.transfer.slice() } : {}),
      ...(node.softMask.backdrop ? { backdrop: [...node.softMask.backdrop] as [number, number, number] } : {}) } } : {}) };
  });
  return { roots: nodes(graph.roots) };
}
