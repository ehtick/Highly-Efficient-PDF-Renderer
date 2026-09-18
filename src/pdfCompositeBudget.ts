import type { VectorScene } from "./pdfVectorExtractor";
import type { ScenePaintNode } from "./scenePaintGraph";

export const PDF_COMPOSITE_MAX_BYTES = 512 * 1024 * 1024;

/** Conservative concurrent surface estimate, including masks, ping-pong buffers and the final copy. */
export function choosePdfCompositeResolution(scene: VectorScene, width: number, height: number,
  byteBudget = PDF_COMPOSITE_MAX_BYTES, bytesPerPixel = 4): { width: number; height: number; scale: number; estimatedSurfaces: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      !Number.isFinite(byteBudget) || byteBudget <= 0 || !Number.isFinite(bytesPerPixel) || bytesPerPixel <= 0)
    throw new RangeError("Invalid PDF composite viewport or byte budget.");
  const depth = (nodes: readonly ScenePaintNode[], level: number): number => {
    if (level > 64) throw new RangeError("PDF compositor exceeds its group nesting budget.");
    let maximum = level;
    for (const node of nodes) if (node.kind === "group") {
      maximum = Math.max(maximum, depth(node.children, level + 1));
      if (node.softMask) maximum = Math.max(maximum, depth(node.softMask.children, level + 2));
    }
    return maximum;
  };
  const estimatedSurfaces = 8 * (depth(scene.paintGraph?.roots ?? [], 0) + 1) + 8;
  const scale = Math.min(1, Math.sqrt(byteBudget / (width * height * bytesPerPixel * estimatedSurfaces)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale, estimatedSurfaces };
}
