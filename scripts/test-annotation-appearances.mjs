import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createCanvas } from "@napi-rs/canvas";
import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";
const hooks = registerHooks({ resolve(s, c, next) {
  return c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? next(`${s}.ts`, c) : next(s, c);
} });
try {
  const { openPdf, renderNativeRetainedCommandSpan } = await import("../src/pdfSession.ts");
  const { renderHeprPageToCanvas2d } = await import("../src/heprCanvas2dRenderer.ts");
  const session = await openPdf({ kind: "bytes", bytes: fixture() });
  try {
    const page = await session.compilePage(0);
    assert.equal(page.annotations.length, 7);
    assert.equal(page.displayProgram.programs.length, 6, "Popup does not create a drawable program");
    assert.equal(page.textIndex.text, "", "comments never become page text");
    assert(session.getDiagnostics().some(d => d.code === "annotation.appearance-synthesized"));
    assert(session.getDiagnostics().some(d => d.code === "annotation.appearance-approximated"));
    const rendered = await renderHeprPageToCanvas2d(page, { scale: 2, surfaceFactory: (w, h) => { const canvas = createCanvas(w, h); return { canvas, context: canvas.getContext("2d") }; } });
    const ctx = rendered.surface.context;
    const pixel = (x, y) => [...ctx.getImageData(x * 2, (100 - y) * 2, 1, 1).data];
    const close = (actual, expected) => assert(actual.every((v, i) => Math.abs(v - expected[i]) <= 3), `${actual} vs ${expected}`);
    close(pixel(12, 45), [255, 255, 128, 255]);
    close(pixel(18, 45), [0, 0, 0, 255]); // Multiply highlight preserves the black page content.
    close(pixel(80, 65), [255, 0, 0, 255]); // Supplied appearance, despite its /C being blue.
    const underline = pixel(40, 30);
    assert(underline[0] > 240 && underline[1] < 20 && underline[2] < 20, "underline uses source color");
    const ink = pixel(40, 10);
    assert(ink[2] > 240 && ink[0] < 20, "ink follows its source path");
    close(pixel(45, 85), [255, 255, 255, 255]); // Note icon remains inside its rectangle.
    const scene = await session.compileVectorPage(0, { vectorFallback: "error" });
    assert.equal(scene.annotations.length, 7);
    assert.equal(scene.rasterLayers.length, 0, "common synthesized marks remain vector geometry");
    assert(scene.drawRuns.some(run => run.blendMode === "Multiply"));
    assert(scene.segmentCount > 0 && scene.fillPathCount > 0);
  } finally { await session.close(); }
  const flagged = await openPdf({ kind: "bytes", bytes: fixture(24) });
  try {
    const page = await flagged.compilePage(0);
    const commands = page.displayProgram.groups[page.displayProgram.rootGroupIndex].commands;
    assert(commands.some(command => command.kind === "invoke-program" && command.viewTransformFlags !== 0));
    const scene = await flagged.compileVectorPage(0);
    assert.equal(scene.annotations.length, 7);
    assert.equal(scene.annotations[3].flags, 24);
    assert(scene.rasterLayers.length > 0);
    assert(flagged.getDiagnostics().some(d => d.code === "annotation.view-transform-approximated"));
    const replay = await renderNativeRetainedCommandSpan(page, 0, commands.length, new AbortController().signal);
    assert(replay.data.some(value => value !== 0));
    assert(commands.some(command => command.kind === "invoke-program" && command.viewTransformFlags !== 0), "raster approximation leaves original flags intact");
  } finally { await flagged.close(); }
  console.log("Annotation appearances: highlight alpha/Multiply, underline, ink, note, source AP, popup and placeholder passed.");
} finally { hooks.deregister(); }

function fixture(viewFlags = 0) {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 12 0 R] >>" },
    { number: 4, body: tinyPdfStream("", "1 1 1 rg 0 0 100 100 re f 0 0 0 rg 15 40 5 10 re f") },
    { number: 5, body: "<< /Subtype /Highlight /Rect [10 40 30 50] /QuadPoints [10 50 30 50 10 40 30 40] /C [1 1 0] /CA .5 >>" },
    { number: 6, body: "<< /Subtype /Underline /Rect [10 29 70 39] /QuadPoints [10 39 70 39 10 30 70 30] /C [1 0 0] /BS << /W 2 >> >>" },
    { number: 7, body: "<< /Subtype /Ink /Rect [10 9 70 21] /InkList [[10 10 60 10 70 20]] /C [0 0 1] /BS << /W 2 >> >>" },
    { number: 8, body: `<< /Subtype /Text /Rect [10 70 30 90] /F ${viewFlags} /Contents (Only in the HTML bubble) >>` },
    { number: 9, body: "<< /Subtype /Popup /Rect [0 -20 100 0] /Parent 8 0 R >>" },
    { number: 10, body: "<< /Subtype /Highlight /Rect [70 60 90 80] /C [0 0 1] /AP << /N 11 0 R >> >>" },
    { number: 11, body: tinyPdfStream("/Subtype /Form /BBox [0 0 20 20]", "1 0 0 rg 0 0 20 20 re f") },
    { number: 12, body: "<< /Subtype /FutureAnnot /Rect [80 10 90 20] /Contents (Future comment) >>" }
  ] });
}
