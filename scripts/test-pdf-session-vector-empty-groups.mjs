import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";
import { buildTinySfnt } from "./lib/tinySfnt.mjs";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) &&
      !/\.[a-z0-9]+(?:[?#]|$)/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });

try {
  const { openPdf } = await import("../src/pdfSession.ts");
  const options = { missingFontResolver: () => ({ sfntBytes: buildTinySfnt(), identifier: "empty-group-vectors" }) };
  for (const content of ["", "q\rQ\r", "\0\t% empty group\r\nq% save\nq\fQ Q % trailing comment"]) {
    const session = await openPdf({ kind: "bytes", bytes: fixture({ content }) }, options);
    try {
      const scene = await session.compileVectorPage(0, { vectorFallback: "error" });
      assert.equal(scene.rasterLayers.length, 0, "an inert group does not rasterize its enclosing stamp");
      assert.equal(scene.fillPathCount, 2, "page and stamp paint survive the empty nested group");
      assert.equal(scene.textInstanceCount, 1);
      assert.equal(scene.textIndex.pages[0].text, "A");
      assert.deepEqual(scene.drawRuns.map(run => run.kind), ["fill", "fill", "text"]);
      assert(!session.getDiagnostics().some(d => d.code.endsWith("raster-fallback")));
    } finally { await session.close(); }
  }

  // Empty wrappers still pass through compilation, including command and
  // graphics-state-depth accounting; the proof cannot bypass resource limits.
  const limited = await openPdf({ kind: "bytes", bytes: fixture({ content: "q Q ".repeat(50) }) }, options);
  try {
    await assert.rejects(limited.compileVectorPage(0, { limits: { maxCommandsPerPage: 40 } }),
      error => error.code === "resource-limit");
    await assert.rejects(limited.compileVectorPage(0, { signal: AbortSignal.abort() }));
  } finally { await limited.close(); }

  const deep = await openPdf({ kind: "bytes", bytes: fixture({ content: "q ".repeat(8) + "Q ".repeat(8) }) },
    { ...options, limits: { maxRecursionDepth: 4 } });
  try {
    await assert.rejects(deep.compileVectorPage(0, { vectorFallback: "error" }),
      error => error.code === "resource-limit", "empty groups still enforce graphics-state depth");
  } finally { await deep.close(); }

  for (const content of ["qQ", "Q", "q q Q"]) {
    const session = await openPdf({ kind: "bytes", bytes: fixture({ content }) }, options);
    try {
      await assert.rejects(session.compileVectorPage(0, { vectorFallback: "error" }),
        "malformed state wrappers must not disappear as empty groups");
    } finally { await session.close(); }
  }

  // A sole path can carry its group's outer alpha without an offscreen pass.
  // PDF uses nonstroking alpha for the group, even when its one child is a stroke.
  for (const [content, expectedFills, expectedStrokes] of [
    ["1 0 0 rg 2 2 6 6 re f", 3, 0],
    ["1 0 0 RG 1 w 2 2 6 6 re S", 2, 4]
  ]) {
    const session = await openPdf({ kind: "bytes", bytes: fixture({ content, state: "/ca .5 /CA .2" }) }, options);
    try {
      const scene = await session.compileVectorPage(0, { vectorFallback: "error" });
      assert.equal(scene.rasterLayers.length, 0);
      assert.equal(scene.fillPathCount, expectedFills);
      assert.equal(scene.segmentCount, expectedStrokes);
      if (expectedStrokes) assert.equal(scene.primitiveMeta[3] % 2, .5, "group alpha overrides the caller's stroke alpha");
      else assert.equal(scene.fillPathMetaC[7], .5, "group opacity is applied exactly once");
    } finally { await session.close(); }
  }

  // More than one paint, a group blending space or internal alpha changes must
  // preserve group compositing instead of distributing the outer opacity.
  for (const settings of [
    { content: "1 0 0 rg 0 0 6 6 re f 2 2 6 6 re f", state: "/ca .5" },
    { content: "1 0 0 RG 1 w 2 2 6 6 re B", state: "/ca .5" },
    { content: "1 0 0 rg 0 0 6 6 re f", group: "/CS /DeviceRGB" },
    { content: "/Inner gs 1 0 0 rg 0 0 6 6 re f", groupResources: "/ExtGState << /Inner << /ca .5 >> >>" }
  ]) {
    const session = await openPdf({ kind: "bytes", bytes: fixture(settings) }, options);
    try {
      const scene = await session.compileVectorPage(0, { vectorFallback: "error" });
      assert.equal(scene.rasterLayers.length, 1, "nontrivial groups retain their bounded composite");
      assert.equal(scene.fillPathCount, 1, "ordinary page geometry stays vector");
      assert(!session.getDiagnostics().some(d => d.code === "page-raster-fallback"));
    } finally { await session.close(); }
  }
  console.log("empty and single-path transparency groups preserve stamp vectors and group opacity");
} finally { hooks.deregister(); }

function fixture({ content = "q Q", state = "", group = "", groupResources = "" } = {}) {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>" },
    { number: 4, body: tinyPdfStream("", "0 1 0 rg 0 0 100 100 re f") },
    { number: 5, body: "<< /Subtype /Stamp /F 4 /Rect [20 20 60 60] /AP << /N 6 0 R >> >>" },
    { number: 6, body: tinyPdfStream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] " +
      "/Resources << /XObject << /Group 7 0 R >> /ExtGState << /Outer 9 0 R >> /Font << /F 8 0 R >> >>",
      "q /Outer gs /Group Do Q 0 0 1 rg 1 1 2 2 re f BT /F 5 Tf 1 4 Td (A) Tj ET") },
    { number: 7, body: tinyPdfStream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency /I false /K false ${group} >> ` +
      `/Resources << /XObject << /Unused 999 0 R >> ${groupResources} >>`, content) },
    { number: 8, body: "<< /Type /Font /Subtype /TrueType /BaseFont /EmptyGroupFixture /Encoding /WinAnsiEncoding >>" },
    { number: 9, body: `<< ${state} >>` }
  ] });
}
