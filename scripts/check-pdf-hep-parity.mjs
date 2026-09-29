// Read-only: parse a PDF and load its existing HEP; never generate an archive.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { sceneFingerprint } from "./lib/sceneFingerprint.mjs";

const [pdfPath, hepPath, ...extra] = process.argv.slice(2);
if (!pdfPath || !hepPath || extra.length) {
  throw new Error("Usage: node --experimental-strip-types scripts/check-pdf-hep-parity.mjs <pdf> <existing-hep>");
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) &&
    !/\.[a-z0-9]+$/i.test(specifier) ? specifier + ".ts" : specifier, context);
} });
try {
  const { loadPdfSceneFromSource } = await import("../src/pdfObjectGenerator.ts");
  const { loadSceneFromHep } = await import("../src/hep.ts");
  const { VectorStrokeLodRuntime } = await import("../src/vectorStrokeLodCore.ts");
  const pdf = (await loadPdfSceneFromSource(new Uint8Array(await readFile(pdfPath)), { sourceKind: "pdf" })).scene;
  const hep = await loadSceneFromHep(new Uint8Array(await readFile(hepPath)));
  const different = [...new Set([...Object.keys(pdf), ...Object.keys(hep)])].filter(key =>
    sceneFingerprint(pdf[key]) !== sceneFingerprint(hep[key]));
  assert.deepEqual(different, [], "PDF and existing HEP scene fields differ");
  const a = new VectorStrokeLodRuntime(pdf), b = new VectorStrokeLodRuntime(hep);
  assert.deepEqual(a.levels.map(level => [level.tolerance, level.segmentCount]),
    b.levels.map(level => [level.tolerance, level.segmentCount]), "LOD levels differ");
  const bounds = pdf.pageBounds;
  for (const [width, height] of [[1920, 1080], [1200, 800]]) {
    const fit = Math.min((width - 128) / Math.max(1, bounds.maxX - bounds.minX),
      (height - 128) / Math.max(1, bounds.maxY - bounds.minY));
    for (const factor of [1, 4, 16]) {
      const zoom = fit * factor;
      for (const runtime of [a, b]) {
        runtime.updateForLocalUnitsPerPixel(1 / zoom);
        runtime.update({ cameraCenterX: (bounds.minX + bounds.maxX) / 2,
          cameraCenterY: (bounds.minY + bounds.maxY) / 2, zoom }, { width, height });
      }
      assert.deepEqual(a.getStats(), b.getStats(), "LOD selection statistics differ");
      for (let index = 0; index < a.levels.length; index++) {
        const left = a.levels[index], right = b.levels[index];
        assert.deepEqual(left.visibleSegmentIds.subarray(0, left.visibleSegmentCount),
          right.visibleSegmentIds.subarray(0, right.visibleSegmentCount), "Visible stroke IDs differ");
      }
      console.log(`${width}x${height}, fit x${factor}: ${a.getStats().renderedSegments}/${pdf.segmentCount} segments (identical)`);
    }
  }
  console.log("PDF/HEP scene fields, LOD levels and visible strokes match exactly.");
} finally { hooks.deregister(); }
