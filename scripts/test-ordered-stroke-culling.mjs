import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";

// Stroke deduplication and containment culling must never change what a
// source-ordered page looks like: only strokes whose pixels are repainted by
// an identical or covering stroke, with nothing else painted in between that
// could show through, may be removed.

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.includes("/src/") &&
      /^\.\.?\//.test(specifier) &&
      !/\.[a-z0-9]+(?:[?#]|$)/i.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

try {
  const { openPdf } = await import("../src/pdfSession.ts");
  const { defaultVectorDrawRuns } = await import("../src/vectorDrawOrder.ts");
  // Scenes whose order equals the fixed fill/stroke/text passes omit draw runs.
  const paintKinds = (scene) => (scene.drawRuns ?? defaultVectorDrawRuns(scene))
    .filter(({ count }) => count > 0).map(({ kind }) => kind);

  const line = (x0, x1) => `${x0} 50 m ${x1} 50 l S`;
  const wipeout = "1 g 20 20 60 60 re f";

  // A later identical stroke repaints the earlier one's pixels: the earlier
  // copy goes, so the line stays above the white wipeout painted in between.
  {
    const scene = await compile(openPdf, `0 G 2 w ${line(10, 90)} ${wipeout} 0 G ${line(10, 90)}`);
    assert.deepEqual(paintKinds(scene), ["fill", "stroke"], "the surviving line paints after the wipeout");
    assert.equal(scene.segmentCount, 1);
    assert.equal(scene.discardedDuplicateCount, 1);
  }

  // An earlier covering stroke does not repaint a later segment, and the
  // wipeout painted between them would show through: keep the later one.
  {
    const scene = await compile(openPdf, `0 G 2 w ${line(10, 90)} ${wipeout} 0 G ${line(30, 70)}`);
    assert.deepEqual(paintKinds(scene), ["stroke", "fill", "stroke"]);
    assert.equal(scene.segmentCount, 2);
    assert.equal(scene.discardedContainedCount, 0);
  }

  // A later covering stroke repaints every pixel of the earlier segment.
  {
    const scene = await compile(openPdf, `0 G 2 w ${line(30, 70)} ${wipeout} 0 G ${line(10, 90)}`);
    assert.deepEqual(paintKinds(scene), ["fill", "stroke"]);
    assert.equal(scene.segmentCount, 1);
    assert.equal(scene.discardedContainedCount, 1);
  }

  // Consecutive opaque strokes of one color with nothing between them are
  // order-free, so a contained segment goes whichever comes first.
  {
    const scene = await compile(openPdf, `0 G 2 w ${line(10, 90)} ${line(30, 70)}`);
    assert.equal(scene.segmentCount, 1);
    assert.equal(scene.discardedContainedCount, 1);
  }

  // B fills before it strokes: its top edge, although inside the earlier
  // black line, must stay above its own white fill.
  {
    const scene = await compile(openPdf, `0 G 2 w ${line(10, 90)} 1 g 30 40 40 10 re B`);
    assert.equal(scene.discardedContainedCount, 0, "a fill-and-stroke path keeps its own stroke");
    assert.deepEqual(paintKinds(scene), ["stroke", "fill", "stroke"]);
  }

  // Identical strokes in different layers can be toggled apart.
  {
    const scene = await compile(openPdf,
      `/OC /Layer BDC 0 G 2 w ${line(10, 90)} EMC 0 G 2 w ${line(10, 90)}`, { layers: true });
    assert.equal(scene.segmentCount, 2);
    assert.equal(scene.discardedDuplicateCount, 0);
  }

  // Repainting a Multiply or translucent stroke darkens it further.
  for (const state of ["/BM /Multiply", "/CA 0.5"]) {
    const scene = await compile(openPdf, `/Paint gs 0 G 2 w ${line(10, 90)} ${line(10, 90)} ${line(30, 70)}`,
      { extGState: state });
    assert.equal(scene.segmentCount, 3, `${state}: repeated strokes accumulate`);
    assert.equal(scene.discardedDuplicateCount, 0);
    assert.equal(scene.discardedContainedCount, 0);
  }

  console.log("Ordered stroke deduplication and containment culling preserve paint order.");
} finally {
  hooks.deregister();
}

async function compile(openPdf, content, { layers = false, extGState = "" } = {}) {
  const resources = [
    extGState ? `/ExtGState << /Paint << ${extGState} >> >>` : "",
    layers ? "/Properties << /Layer 6 0 R >>" : ""
  ].join(" ");
  const session = await openPdf({ kind: "bytes", bytes: writeTinyPdf({ objects: [
    { number: 1, body: `<< /Type /Catalog /Pages 2 0 R ${layers ? "/OCProperties << /OCGs [6 0 R] /D << /Order [6 0 R] >> >>" : ""} >>` },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << ${resources} >> /Contents 4 0 R >>` },
    { number: 4, body: tinyPdfStream("", content) },
    ...(layers ? [{ number: 6, body: "<< /Type /OCG /Name (Layer) >>" }] : [])
  ] }) });
  try {
    return await session.compileVectorPage(0);
  } finally {
    await session.close();
  }
}
