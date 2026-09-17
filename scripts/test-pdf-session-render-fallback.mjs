import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";
import { buildTinySfnt } from "./lib/tinySfnt.mjs";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !specifier.endsWith(".ts")) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
try {
  const { openPdf } = await import("../src/pdfSession.ts");
  const { renderHeprPageToCanvas2d } = await import("../src/heprCanvas2dRenderer.ts");
  const { openPdfInNodeWorker } = await import("../src/pdf/workerClient.ts");
  const font = buildTinySfnt();
  const fontOptions = { missingFontResolver: () => ({ sfntBytes: font, identifier: "fallback-fixture" }) };
  const fallbackAnnotation = fixture({
    annotations: true, content: "q /G gs 0 0 1 1 re f Q", state: "/ca .5 /AIS true"
  });
  const cases = [
    ["annotation after unsupported page paint", fallbackAnnotation, (scene) => {
      assertPixel(scene, 15, 10, [255, 0, 0, 255]);
      assertPixel(scene, 2, 2, [0, 0, 0, 0]);
    }],
    ["arbitrary image clip", fixture({ content: "0 0 m 40 0 l 0 20 l h W n 40 0 0 20 0 0 cm /Im Do", image: true }), (scene) => {
      assertPixel(scene, 5, 5, [255, 0, 0, 255]);
      assertPixel(scene, 35, 15, [0, 0, 0, 0]);
    }],
    ["one-bit image", fixture({ content: "40 0 0 20 0 0 cm /Im Do", image: true, oneBit: true }), (scene) => {
      assertPixel(scene, 5, 5, [0, 0, 0, 255]);
      assertPixel(scene, 35, 5, [255, 255, 255, 255]);
    }],
    ["filled and outlined text", fixture({ content: "1 0 0 rg 0 0 1 RG .4 w BT /F 30 Tf 2 Tr 5 5 Td (AB) Tj ET", font: true }), (scene) => {
      const index = scene.textIndex.pages[0];
      assert.equal(index.text.replaceAll(" ", ""), "AB");
      assert.ok([...index.charInstance].filter(ref => ref !== -1).every(ref => ref >= 0));
      assert.equal(scene.textInstanceCount, 4, "two glyph fills and two vector outlines");
      assert.deepEqual([...scene.textInstanceC], [1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
    }]
  ];
  for (const [name, bytes, check] of cases) {
    const warnings = [];
    const session = await openPdf({ kind: "bytes", bytes }, { ...fontOptions, onDiagnostic: d => warnings.push(d) });
    try {
      const scene = await session.compileVectorPage(0, { optimization: "none" });
      assert.equal(scene.rasterLayers.length, name === "filled and outlined text" ? 0 : 1, name);
      assert.equal(scene.fillPathCount, 0, name);
      if (name === "arbitrary image clip" || name === "one-bit image") {
        assert(!warnings.some(d => d.code.endsWith("raster-fallback")));
        if (name === "arbitrary image clip") assert.equal(scene.clipPaths.length, 1);
        assert.equal(scene.rasterLayers[0].width, name === "one-bit image" ? 2 : 1,
          "the original image is retained without resampling");
        assert.equal(scene.rasterLayers[0].height, 1);
      } else if (name === "filled and outlined text") {
        assert(!warnings.some(d => d.code.endsWith("raster-fallback")));
      } else {
        assert.equal(warnings.filter(d => d.code === "page-raster-fallback").length, 1, name);
        assert.equal(warnings.find(d => d.code === "page-raster-fallback").pageIndex, 0);
      }
      check(scene);
      const second = await session.compileVectorPage(0, { optimization: "none" });
      assert.deepEqual(second.rasterLayerData, scene.rasterLayerData, "repeat operations own usable resources");
    } finally { await session.close(); }
  }

  const simple = await openPdf({ kind: "bytes", bytes: fixture({ content: "1 0 0 rg 0 0 20 10 re f" }) });
  try {
    assert.equal((await simple.compileVectorPage(0)).rasterLayers.length, 0, "supported pages remain vectors");
    assert.equal(simple.getDiagnostics().length, 0);
  } finally { await simple.close(); }

  const bounded = await openPdf({ kind: "bytes", bytes: fallbackAnnotation });
  try {
    const scene = await bounded.compileVectorPage(0, { limits: { maxImagePixels: 100, maxImageDimension: 12 } });
    assert.ok(scene.rasterLayerWidth * scene.rasterLayerHeight <= 100);
    assert.ok(scene.rasterLayerWidth <= 12 && scene.rasterLayerHeight <= 12);
    await assert.rejects(bounded.compileVectorPage(0, { signal: AbortSignal.abort() }));
    await assert.rejects(bounded.compileVectorPage(0, { limits: { maxPathCoordinatesPerPage: 1 } }),
      error => error.code === "resource-limit");
    await assert.rejects(bounded.compileVectorPage(0, { vectorFallback: "error" }),
      error => /alpha-as-shape/.test(error.message));
  } finally { await bounded.close(); }

  for (const transfer of ["/TR 9 0 R", "/TR2 [9 0 R /Identity 9 0 R /Identity]", "/UCR2 9 0 R /BG2 9 0 R /HT << /HalftoneType 1 >>"]) {
    const session = await openPdf({ kind: "bytes", bytes: fixture({ content: "/G gs .5 g 0 0 20 10 re f", state: transfer }) });
    try {
      assert.equal((await session.compileVectorPage(0)).fillPathCount, 1);
      assert.ok(session.getDiagnostics().some(d => d.code === "extgstate-approximation" && d.pageIndex === 0));
    } finally { await session.close(); }
  }
  const reset = await openPdf({ kind: "bytes", bytes: fixture({ content: "/G gs 0 0 10 10 re f", state: "/TR 9 0 R /TR2 /Default /UCR2 /Default /HT /Default" }) });
  try { await reset.compilePage(0); assert.equal(reset.getDiagnostics().length, 0); }
  finally { await reset.close(); }

  for (const nonlinear of [false, true, "reverse"]) {
    const session = await openPdf({ kind: "bytes", bytes: gradientFixture(nonlinear) });
    try {
      const page = await session.compilePage(0);
      const warnings = [];
      const rendered = await renderHeprPageToCanvas2d(page, {
        surfaceFactory, scale: 4, maxGradientSubdivisionDepth: 0, onDiagnostic: d => warnings.push(d)
      });
      if (nonlinear === true) assert.equal(warnings.filter(d => d.code === "gradient-approximation").length, 1);
      else {
        assert.equal(warnings.length, 0, "a hard stitching step does not exhaust the tolerance budget");
        await assert.rejects(renderHeprPageToCanvas2d(page, { surfaceFactory, maxGradientStops: 2 }),
          error => error.code === "canvas2d.resource-limit", "sampling never exceeds its hard budget");
        const pixel = x => [...rendered.surface.context.getImageData(x, 20, 1, 1).data];
        assert.deepEqual(pixel(79), nonlinear === "reverse" ? [0, 0, 255, 255] : [255, 0, 0, 255]);
        assert.deepEqual(pixel(80), nonlinear === "reverse" ? [255, 0, 0, 255] : [0, 0, 255, 255]);
      }
    } finally { await session.close(); }
  }

  const approximate = await openPdf({ kind: "bytes", bytes: fixture({
    annotations: true, state: "/ca .5 /AIS true", content: "/G gs 1 0 0 rg 0 0 40 20 re f"
  }) });
  try {
    const scene = await approximate.compileVectorPage(0);
    assertPixel(scene, 2, 2, [255, 0, 0, 128]);
    assert.ok(approximate.getDiagnostics().some(d => d.code === "compositing-approximation"));
  } finally { await approximate.close(); }

  const resolverError = new Error("caller font resolver failed");
  let resolverCalls = 0;
  const failed = await openPdf({ kind: "bytes", bytes: cases[3][1] }, {
    missingFontResolver() { resolverCalls += 1; throw resolverError; }
  });
  try {
    await assert.rejects(failed.compileVectorPage(0));
    assert.equal(resolverCalls, 1, "caller failures are not retried through the raster path");
    assert.ok(!failed.getDiagnostics().some(d => d.code === "page-raster-fallback"));
  } finally { await failed.close(); }

  // The real worker must forward the warning and transfer raster/text buffers.
  const diagnostics = [];
  const worker = await openPdfInNodeWorker({ kind: "bytes", bytes: cases[0][1] }, {
    workerUrl: sourceWorkerBootstrapUrl(new URL("../src/pdf/pdfWorkerEntry.ts", import.meta.url)),
    onDiagnostic: d => diagnostics.push(d)
  });
  try {
    for (let i = 0; i < 2; i += 1) cases[0][2](await worker.compileVectorPage(0));
    assert.ok(diagnostics.some(d => d.code === "page-raster-fallback"));
    assert.ok(worker.getDiagnostics().some(d => d.code === "page-raster-fallback"));
  } finally { await worker.close(); }
} finally { hooks.deregister(); }

function surfaceFactory(width, height) {
  const canvas = createCanvas(width, height);
  return { canvas, context: canvas.getContext("2d") };
}
function assertPixel(scene, x, y, expected) {
  const layer = scene.rasterLayers[0];
  let clipIndex = scene.drawRuns?.find(run => run.kind === "raster" && run.first === 0)?.clipIndex ?? -1;
  while (clipIndex >= 0) {
    const clip = scene.clipPaths[clipIndex];
    const path = new Path2D();
    for (let i = 0; i < clip.edges.length; i += 4) {
      if (i === 0 || clip.edges[i] !== clip.edges[i - 2] || clip.edges[i + 1] !== clip.edges[i - 1]) path.moveTo(clip.edges[i], clip.edges[i + 1]);
      path.lineTo(clip.edges[i + 2], clip.edges[i + 3]);
    }
    // Independent Canvas winding oracle; the raster's alpha remains unchanged.
    if (!createCanvas(1, 1).getContext("2d").isPointInPath(path, x, y, clip.fillRule ? "evenodd" : "nonzero")) {
      assert.deepEqual([0, 0, 0, 0], expected); return;
    }
    clipIndex = clip.parent;
  }
  const width = scene.pageBounds.maxX, height = scene.pageBounds.maxY;
  const offset = (Math.floor((height - y) / height * layer.height) * layer.width + Math.floor(x / width * layer.width)) * 4;
  assert.deepEqual([...layer.data.subarray(offset, offset + 4)], expected);
}
function fixture({ content = "", annotations = false, image = false, oneBit = false, font = false, state = "" } = {}) {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 20] /Resources << ${image ? "/XObject << /Im 5 0 R >>" : ""} ${font ? "/Font << /F 7 0 R >>" : ""} ${state ? "/ExtGState << /G 8 0 R >>" : ""} >> /Contents 4 0 R ${annotations ? "/Annots [6 0 R]" : ""} >>` },
    { number: 4, body: tinyPdfStream("", content) },
    { number: 5, body: tinyPdfStream(`/Type /XObject /Subtype /Image /Width ${oneBit ? 2 : 1} /Height 1 /BitsPerComponent ${oneBit ? 1 : 8} /ColorSpace /Device${oneBit ? "Gray" : "RGB"}`, oneBit ? Uint8Array.of(0x40) : Uint8Array.of(255, 0, 0)) },
    { number: 6, body: "<< /Type /Annot /Subtype /Square /Rect [10 5 20 15] /IC [1 0 0] /Border [0 0 0] >>" },
    { number: 7, body: "<< /Type /Font /Subtype /TrueType /BaseFont /FallbackFixture /Encoding /WinAnsiEncoding >>" },
    { number: 8, body: `<< ${state} >>` },
    { number: 9, body: "<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >>" }
  ] });
}
function gradientFixture(nonlinear) {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 20] /Resources << /Shading << /S 5 0 R >> >> /Contents 4 0 R >>" },
    { number: 4, body: tinyPdfStream("", "/S sh") },
    { number: 5, body: "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 40 0] /Function 6 0 R /Extend [true true] >>" },
    { number: 6, body: nonlinear === "reverse" ? "<< /FunctionType 3 /Domain [0 1] /Functions [9 0 R] /Bounds [] /Encode [1 0] >>" : nonlinear ? "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 40 >>" : "<< /FunctionType 3 /Domain [0 1] /Functions [7 0 R 8 0 R 8 0 R] /Bounds [.5 .5] /Encode [0 1 0 1 0 1] >>" },
    { number: 7, body: "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [1 0 0] /N 1 >>" },
    { number: 8, body: "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [0 0 1] /N 1 >>" },
    { number: 9, body: "<< /FunctionType 3 /Domain [0 1] /Functions [7 0 R 8 0 R] /Bounds [.5] /Encode [0 1 0 1] >>" }
  ] });
}
function sourceWorkerBootstrapUrl(entryUrl) {
  const source = `import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes("/src/") && /^\\.\\.?\\//.test(specifier) && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      return nextResolve(specifier, context);
    }}); await import(${JSON.stringify(entryUrl.href)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}
