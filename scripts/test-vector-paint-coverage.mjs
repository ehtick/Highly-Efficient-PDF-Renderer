import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) &&
      !/\.[a-z0-9]+(?:[?#]|$)/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });

try {
  const { openPdf } = await import("../src/pdfSession.ts");
  const { getScenePrimitive, ScenePrimitivePicker } = await import("../src/scenePrimitives.ts");
  const { composeVectorScenesInGrid } = await import("../src/pdfVectorExtractor.ts");
  const { buildHep } = await import("../src/hepBuilder.ts");
  const { loadSceneFromHep } = await import("../src/hep.ts");
  const images = await openPdf({ kind: "bytes", bytes: fixture(
    "q /Half gs 10 0 0 10 0 0 cm /I Do Q q 10 0 0 10 20 0 cm /I Do Q " +
    "q /Zero gs 10 0 0 10 40 0 cm /I Do Q q 1 0 0 1 60 0 cm /F Do Q"
  ) });
  let scene;
  try { scene = await images.compileVectorPage(0, { vectorFallback: "error", optimization: "none" }); }
  finally { await images.close(); }
  assert.equal(scene.rasterLayers.length, 4);
  assert.deepEqual(scene.rasterLayers.map(layer => layer.opacity ?? 1), [.5, 1, 0, .5],
    "each image occurrence retains its alpha, including inside a Form");
  for (const layer of scene.rasterLayers) assert.deepEqual([...layer.data], [255, 0, 0, 255],
    "constant graphics-state alpha does not rewrite or duplicate decoded image pixels");
  const info = getScenePrimitive(scene, { kind: "raster", index: 0 });
  assert.equal(info.opacity, .5);
  assert.equal(info.getSegmentStyle(0).opacity, .5);
  const picker = new ScenePrimitivePicker(scene);
  const pick = point => picker.pick({ point, clientPoint: point, project: p => p, unproject: p => p, tolerancePx: 0 });
  assert.equal((await pick({ x: 5, y: 5 }))?.primitive.index, 0);
  assert.equal(await pick({ x: 45, y: 5 }), null, "an alpha-zero occurrence is not pickable");
  picker.dispose();
  const composed = composeVectorScenesInGrid([scene, scene], 2);
  assert.deepEqual(composed.rasterLayers.map(layer => layer.opacity ?? 1), [.5, 1, 0, .5, .5, 1, 0, .5]);
  const archive = await buildHep(scene, { encodeRasterImages: false, compression: "store" });
  const restored = await loadSceneFromHep(await archive.arrayBuffer());
  assert.deepEqual(restored.rasterLayers.map(layer => layer.opacity ?? 1), [.5, 1, 0, .5]);

  // More than the old shader limit, with a hole that spans the former limit.
  // Keeping this as one winding domain prevents subpath splitting from filling it in.
  const subpaths = ["0 0 10 10 re", ...Array.from({ length: 520 }, (_, index) => {
    const x = 12 + (index % 26) * 2, y = 12 + Math.floor(index / 26) * 2;
    return `${x} ${y} 1 1 re`;
  }), "2 2 m 2 8 l 8 8 l 8 2 l h"];
  const compound = await openPdf({ kind: "bytes", bytes: fixture(`${subpaths.join(" ")} f`) });
  let compoundScene;
  try { compoundScene = await compound.compileVectorPage(0, { vectorFallback: "error", optimization: "none" }); }
  finally { await compound.close(); }
  assert.equal(compoundScene.rasterLayers.length, 0);
  assert.equal(compoundScene.fillPathCount, 1, "all subpaths share one original paint");
  assert.equal(compoundScene.fillSegmentCount, 522 * 4);
  const compoundInfo = getScenePrimitive(compoundScene, { kind: "fill", index: 0 });
  assert.equal(compoundInfo.segmentCount, 522 * 4);
  const compoundPicker = new ScenePrimitivePicker(compoundScene);
  const compoundPick = point => compoundPicker.pick({ point, clientPoint: point,
    project: p => p, unproject: p => p, tolerancePx: 0 });
  assert.equal(await compoundPick({ x: 5, y: 5 }), null, "the late reversed contour cuts out the original rectangle");
  assert.equal((await compoundPick({ x: 1, y: 1 }))?.primitive.kind, "fill");
  assert.equal((await compoundPick({ x: 62.5, y: 50.5 }))?.primitive.kind, "fill",
    "segments beyond the former 2048-segment limit remain inspectable");
  compoundPicker.dispose();
  console.log("vector paint coverage: per-occurrence image opacity, Form flattening, picking, composition, HEP and compound winding passed");
} finally { hooks.deregister(); }

function fixture(content) {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 80] /Resources << /XObject << /I 5 0 R /F 6 0 R >> /ExtGState << /Half << /ca .5 >> /Zero << /ca 0 >> >> >> /Contents 4 0 R >>" },
    { number: 4, body: tinyPdfStream("", content) },
    { number: 5, body: tinyPdfStream("/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8", new Uint8Array([255, 0, 0])) },
    { number: 6, body: tinyPdfStream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /I 5 0 R >> /ExtGState << /Half << /ca .5 >> >> >>", "/Half gs 10 0 0 10 0 0 cm /I Do") }
  ] });
}
