import * as THREE from "three";
import type { Bounds, VectorScene } from "./pdfVectorExtractor";
import { analyzePlanarBoundsProjectionInto, createPlanarBoundsProjection } from "./planarProjection";
import type { ThreePageTransforms } from "./threePageTransforms";

export interface ThreePageFrame {
  scene: VectorScene;
  paintBounds: Bounds;
  dataToDocument: THREE.Matrix4;
  dataToClip: THREE.Matrix4;
  visible: boolean;
  opaque: boolean;
  cullingBounds?: Bounds;
}

/** Project actual paint extents, including off-page content, before commuting pages. */
export function updateThreePageBatchFrame(table: ThreePageTransforms, pages: readonly ThreePageFrame[], viewport: { width: number; height: number }, nearDepth = -1) {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const boxes: { x0: number; y0: number; x1: number; y1: number; z0: number; z1: number; opaque: boolean; bounded: boolean }[] = [];
  const projection = createPlanarBoundsProjection(), inkProjection = createPlanarBoundsProjection(), point = new THREE.Vector4();
  let minUnits = Infinity, maxUnits = 0, reason: string | null = null;
  pages.forEach((page, index) => {
    const coarseBounds = table.coarseBounds[index], paint = page.paintBounds;
    const ink = { minX: Math.min(paint.minX, coarseBounds.minX), minY: Math.min(paint.minY, coarseBounds.minY),
      maxX: Math.max(paint.maxX, coarseBounds.maxX), maxY: Math.max(paint.maxY, coarseBounds.maxY) };
    const r = page.scene.pageBounds;
    const b = { minX: Math.min(r.minX, ink.minX), minY: Math.min(r.minY, ink.minY),
      maxX: Math.max(r.maxX, ink.maxX), maxY: Math.max(r.maxY, ink.maxY) };
    analyzePlanarBoundsProjectionInto(b, page.dataToClip.elements, viewport, projection);
    let z0 = Infinity, z1 = -Infinity, behind = 0;
    for (const x of [b.minX,b.maxX]) for (const y of [b.minY,b.maxY]) {
      point.set(x,y,0,1).applyMatrix4(page.dataToClip);
      if (point.w <= 1e-8) behind++;
      z0 = Math.min(z0,point.z/point.w); z1 = Math.max(z1,point.z/point.w);
    }
    // A rectangle crossing the eye/near plane needs the independent adaptive path.
    if (page.visible && behind !== 4 && (!projection.stable || behind || z0 < nearDepth || !Number.isFinite(z0 + z1))) reason = "unstable-projection";
    const visible = page.visible && behind !== 4 && projection.visible && z1 >= nearDepth && z0 <= 1;
    const fine = 1 / Math.max(1e-8,projection.maxPixelsPerLocalUnit);
    const coarse = 1 / Math.max(1e-8,projection.minPixelsPerLocalUnit);
    table.setPage(index,page.dataToDocument,page.dataToClip,visible,Number.isFinite(coarse) ? coarse : 1);
    if (!visible) return;
    minUnits = Math.min(minUnits,fine); maxUnits = Math.max(maxUnits,coarse);
    const clip = page.cullingBounds;
    bounds.minX = Math.min(bounds.minX,clip ? Math.max(b.minX,clip.minX) : b.minX);
    bounds.minY = Math.min(bounds.minY,clip ? Math.max(b.minY,clip.minY) : b.minY);
    bounds.maxX = Math.max(bounds.maxX,clip ? Math.min(b.maxX,clip.maxX) : b.maxX);
    bounds.maxY = Math.max(bounds.maxY,clip ? Math.min(b.maxY,clip.maxY) : b.maxY);
    // Hairline/AA expansion uses the least magnified part of the page. Account
    // for anisotropy in screen space, and require paint plus AA inside the
    // opaque sheet before relying on its depth to isolate overlapping pages.
    const aaPixels = page.scene.segmentCount || page.scene.gradientStrokeSegmentCount ? 2 : 0.5;
    const localMargin = aaPixels * coarse, pixels = Math.max(aaPixels, localMargin * projection.maxPixelsPerLocalUnit);
    const hasInk = ink.minX <= ink.maxX && ink.minY <= ink.maxY;
    if (hasInk) analyzePlanarBoundsProjectionInto(ink, page.dataToClip.elements, viewport, inkProjection);
    // Background quads have no outward AA. Expanding the whole sheet would
    // falsely overlap tightly spaced book thumbnails even with wide margins.
    boxes.push({ x0: Math.min(projection.minX, hasInk ? inkProjection.minX-pixels : Infinity),
      y0: Math.min(projection.minY, hasInk ? inkProjection.minY-pixels : Infinity),
      x1: Math.max(projection.maxX, hasInk ? inkProjection.maxX+pixels : -Infinity),
      y1: Math.max(projection.maxY, hasInk ? inkProjection.maxY+pixels : -Infinity),z0,z1,
      opaque: page.opaque, bounded: ink.minX-localMargin >= r.minX && ink.minY-localMargin >= r.minY &&
        ink.maxX+localMargin <= r.maxX && ink.maxY+localMargin <= r.maxY });
  });
  boxes.sort((a, b) => a.x0 - b.x0);
  for (let i=0;i<boxes.length;i++) for (let j=i+1;j<boxes.length;j++) {
    const a=boxes[i],b=boxes[j];
    if (b.x0 > a.x1) break;
    if (a.y1 < b.y0 || b.y1 < a.y0) continue;
    // Opaque sheets with disjoint depth intervals can use a shared depth pass.
    // Coplanar/intersecting sheets and translucent overlaps retain page order.
    if (!a.opaque || !b.opaque || !a.bounded || !b.bounded || !(a.z1 + 1e-5 < b.z0 || b.z1 + 1e-5 < a.z0))
      reason ??= "overlapping-page-paints";
  }
  table.minUnitsPerPixel = Number.isFinite(minUnits) ? Math.max(1e-8,minUnits) : 1;
  table.maxUnitsPerPixel = Number.isFinite(maxUnits) && maxUnits > 0 ? maxUnits : table.minUnitsPerPixel;
  table.opaque = boxes.every(box=>box.opaque);
  table.finishUpdate();
  if (!boxes.length) Object.assign(bounds,{minX:0,minY:0,maxX:0,maxY:0});
  return { reason, view: { viewState: {cameraCenterX:(bounds.minX+bounds.maxX)/2,cameraCenterY:(bounds.minY+bounds.maxY)/2,zoom:1/table.minUnitsPerPixel},
    nativeViewport: viewport, cullingBounds: bounds } };
}
