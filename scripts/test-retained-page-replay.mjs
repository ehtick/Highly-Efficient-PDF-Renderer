import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
try {
  const { openPdf, renderNativeRetainedCommandSpan } = await import("../src/pdfSession.ts");
  const { RetainedPageReplay, applyRetainedPageVisibility } = await import("../src/retainedPageReplay.ts");
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const session = await openPdf({ kind: "bytes", bytes: writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 12 10] /Resources << >> /Contents 4 0 R >>" },
    { number: 4, body: tinyPdfStream("", "1 0 0 rg 1 1 4 4 re f 0 0 1 rg 7 1 4 4 re f") }
  ] }) });
  let page;
  try { page = await session.compilePage(0, { optimization: "none" }); } finally { await session.close(); }
  const root = page.displayProgram.groups[page.displayProgram.rootGroupIndex];
  assert.equal(root.commands.length, 2);
  root.commands[0].optionalContentIndex = 0;
  root.commands[1].optionalContentIndex = 1;
  page.stores.optionalContent = { names: ["A", "B"], defaultVisible: new Uint8Array([1, 0]) };
  const resource = { page, optionalContentConditions: new Int32Array([0, 1]), matrix: new Float32Array([2, 0, 0, 2, 30, 40]) };
  const original = structuredClone(page);
  const snapshot = conditions => ({ revision: 1, layers: [], conditions: new Uint8Array(conditions) });
  const visiblePage = applyRetainedPageVisibility(resource, snapshot([0, 1]));
  assert.equal(visiblePage.stores.paths, page.stores.paths, "replay reuses canonical path buffers");
  assert.equal(visiblePage.displayProgram, page.displayProgram);
  assert.deepEqual([...visiblePage.stores.optionalContent.defaultVisible], [0, 1]);
  const signal = new AbortController().signal;
  const image = await renderNativeRetainedCommandSpan(visiblePage, 0, 2, signal);
  assert(image);
  assert.deepEqual([...image.matrix], [12, 0, 0, -10, 0, 10], "runtime frames always cover full structural page bounds");
  const sample = (layer, x, y) => {
    const u = Math.min(layer.width - 1, Math.floor(x / 12 * layer.width));
    const v = Math.min(layer.height - 1, Math.floor((10 - y) / 10 * layer.height));
    return [...layer.data.subarray((v * layer.width + u) * 4, (v * layer.width + u) * 4 + 4)];
  };
  assert.equal(sample(image, 3, 3)[3], 0, "hidden layer is absent from replay");
  assert.deepEqual(sample(image, 9, 3), [0, 0, 255, 255]);
  const scene = createEmptyVectorScene();
  scene.retainedPages = [resource];
  scene.rasterLayers = [{ width: 1, height: 1, data: new Uint8Array(4), matrix: new Float32Array([24, 0, 0, -20, 30, 60]), paintOrder: 9, pageIndex: 2 }];
  scene.paintGraph = { roots: [{ kind: "retained", retainedPage: 0, firstCommand: 0, count: 2, rasterIndex: 0 }] };
  let renders = 0;
  const replay = new RetainedPageReplay(scene, async (...args) => { renders++; return renderNativeRetainedCommandSpan(...args); });
  const first = await replay.prepare(snapshot([1, 0]), { signal });
  assert.equal(replay.getLayers().get(0), scene.rasterLayers[0], "prepared resources cannot change committed state");
  first.commit();
  assert.deepEqual([...replay.getLayers().get(0).matrix], [24, 0, 0, -20, 30, 60]);
  assert.equal(replay.getLayers().get(0).pageIndex, 2);
  const repeated = await replay.prepare(snapshot([1, 0]), { signal }); repeated.commit();
  assert.equal(renders, 1, "unchanged page visibility reuses replay pixels");
  const changed = await replay.prepare(snapshot([0, 1]), { signal }); changed.commit();
  assert.equal(renders, 2);
  assert.deepEqual(sample(replay.getLayers().get(0), 9, 3), [0, 0, 255, 255]);
  const stale = await replay.prepare(snapshot([1, 0]), { signal });
  const current = await replay.prepare(snapshot([0, 1]), { signal });
  assert.throws(() => stale.commit(), { name: "AbortError" }); current.commit();
  const aborted = AbortSignal.abort(new Error("cancel replay"));
  await assert.rejects(replay.prepare(snapshot([1, 1]), { signal: aborted }), /cancel replay/);
  assert.deepEqual(page, original, "all replay operations leave retained source data unchanged");
  replay.dispose();
  await assert.rejects(replay.prepare(snapshot([1, 1]), { signal }), /disposed/);
  await testBackdropReplay({ openPdf, renderNativeRetainedCommandSpan, RetainedPageReplay, createEmptyVectorScene, snapshot, sample, signal });
  console.log("Retained page replay passed: self-contained Canvas rendering, HEP backdrop changes, hidden resources, stable slots/quads, cache reuse, and cancellation.");
} finally { hooks.deregister(); }

async function testBackdropReplay({ openPdf, renderNativeRetainedCommandSpan, RetainedPageReplay, createEmptyVectorScene, snapshot, sample, signal }) {
  const { buildHep } = await import("../src/hepBuilder.ts");
  const { loadSceneFromHep } = await import("../src/hep.ts");
  const session = await openPdf({ kind: "bytes", bytes: writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 12 10] /Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>" },
    { number: 4, body: tinyPdfStream("", "1 0 0 rg 0 0 12 10 re f /Fm Do") },
    { number: 5, body: tinyPdfStream("/Type /XObject /Subtype /Form /BBox [0 0 12 10] /Resources << /ExtGState << /Screen 6 0 R >> >>",
      "/Screen gs 0 0 1 rg 2 2 8 6 re f") },
    { number: 6, body: "<< /Type /ExtGState /BM /Screen /ca 0.5 >>" }
  ] }) });
  let page;
  try { page = await session.compilePage(0, { optimization: "none" }); }
  finally { await session.close(); }
  const root = page.displayProgram.groups[page.displayProgram.rootGroupIndex];
  assert.equal(root.commands.length, 2);
  assert.ok(["group", "invoke-program"].includes(root.commands[1].kind));
  root.commands[0].optionalContentIndex = 0;
  page.stores.optionalContent = { names: ["Backdrop"], defaultVisible: Uint8Array.of(1) };
  const scene = createEmptyVectorScene();
  scene.pageCount = scene.pagesPerRow = 1;
  scene.bounds = scene.pageBounds = { minX: 0, minY: 0, maxX: 12, maxY: 10 };
  scene.pageRects = Float32Array.of(0, 0, 12, 10);
  scene.optionalContent = {
    groups: [{ id: "backdrop", name: "Backdrop", defaultVisible: true, locked: false, usedInView: true }],
    conditions: [{ kind: "group", groupId: "backdrop" }], order: [{ kind: "group", groupId: "backdrop" }], radioGroups: []
  };
  scene.retainedPages = [{ page, optionalContentConditions: Int32Array.of(0), matrix: Float32Array.of(1, 0, 0, 1, 0, 0) }];
  scene.rasterLayers = await Promise.all([0, 1].map(first => renderNativeRetainedCommandSpan(page, first, 1, signal)));
  assert(scene.rasterLayers.every(Boolean));
  scene.drawRuns = [{ kind: "raster", first: 0, count: 1, optionalContent: 0 }, { kind: "raster", first: 1, count: 1 }];
  scene.paintGraph = { roots: [0, 1].map(index => ({ kind: "retained", retainedPage: 0, firstCommand: index,
    count: 1, rasterIndex: index, ...(index === 0 ? { optionalContent: 0 } : {}) })) };
  const bytes = await (await buildHep(scene, { compression: "store", encodeRasterImages: false })).arrayBuffer();
  const loaded = await loadSceneFromHep(bytes);
  const canonical = loaded.rasterLayers.map(layer => layer.data.slice());
  let calls = 0;
  const replay = new RetainedPageReplay(loaded, async (...args) => {
    calls++; return renderNativeRetainedCommandSpan(...args);
  });
  const enabled = await replay.prepare(snapshot([1]), { signal }); enabled.commit();
  const before = sample(replay.getLayers().get(1), 4, 4);
  const disabled = await replay.prepare(snapshot([0]), { signal }); disabled.commit();
  const after = sample(replay.getLayers().get(1), 4, 4);
  assert.equal(calls, 3, "hiding the backdrop replays the unchanged blended island because its prefix changed");
  assert(before[0] >= 254 && before[2] >= 254 && Math.abs(before[3] - 128) <= 1,
    "Screen over opaque red needs a magenta correction layer");
  assert(after[0] <= 1 && after[2] >= 254 && Math.abs(after[3] - 128) <= 1,
    "after hiding red, the same canonical island replays to translucent blue");
  assert.equal(sample(replay.getLayers().get(0), 4, 4)[3], 0);
  const restored = await replay.prepare(snapshot([1]), { signal }); restored.commit();
  assert.deepEqual(sample(replay.getLayers().get(1), 4, 4), before, "backdrop restoration is reproducible without source PDF bytes");
  assert.deepEqual(loaded.retainedPages[0].page.stores.optionalContent.defaultVisible, Uint8Array.of(1));
  loaded.rasterLayers.forEach((layer, index) => assert.deepEqual(layer.data, canonical[index]));
  replay.dispose();
}
