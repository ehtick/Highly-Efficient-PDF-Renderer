import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createCanvas } from "@napi-rs/canvas";

import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !specifier.endsWith(".ts")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const {
  openNativePdfDocument, NativePdfAppearanceSynthesizer, resolveNativePdfAnnotationAppearanceWithSynthesis
} = await import("../src/pdf/nativePdf.ts");
const { NativePdfFormAppearanceRegistry } = await import("../src/pdf/nativeForms.ts");
const { openPdf } = await import("../src/pdfSession.ts");
const { validateHeprPageData } = await import("../src/heprDocumentDataValidation.ts");
const { renderHeprPageToCanvas2d } = await import("../src/heprCanvas2dRenderer.ts");
const decoder = new TextDecoder();

try {
  const cloud = "/BS << /W 2 /S /S >> /BE << /S /C /I 1 >>";
  const outline = await synthesize(cloud);
  assert.match(outline.content, / c\nh S\nQ$/);
  assert.doesNotMatch(outline.content, / re /);
  assert.deepEqual(outline.bbox, [0, 0, 120, 80]);

  const stronger = await synthesize(cloud.replace("/I 1", "/I 2"));
  assert.ok(curveCount(outline.content) > curveCount(stronger.content),
    "greater intensity produces larger, fewer lobes on the same rectangle");
  assert.ok(curveCount((await synthesize(cloud.replace("/I 1", "/I 0.25"))).content) > curveCount(outline.content));
  const plain = await synthesize("/BS << /W 2 /S /S >>");
  for (const effect of ["/BE << /S /C >>", "/BE << /S /C /I 0 >>", "/BE << /S /S /I (ignored) >>"]) {
    assert.equal((await synthesize(`/BS << /W 2 /S /S >> ${effect}`)).content, plain.content);
  }

  const indirect = await synthesize("/BS << /W 2 /S /S >> /BE 10 0 R", {
    objects: [{ number: 10, body: "<< /S /C /I 11 0 R >>" }, { number: 11, body: "1" }]
  });
  assert.equal(indirect.content, outline.content);
  const dashed = await synthesize(cloud.replace("/S /S", "/S /D /D [3 2]"));
  assert.match(dashed.content, /2 w\n\[3 2\] 0 d/);
  assert.equal(curveCount(dashed.content), curveCount(outline.content));
  assert.equal((await synthesize(cloud.replace("/S /S", "/S /U"))).content, outline.content,
    "a positive cloudy effect supplies the border shape, including for /BS /U");

  for (const [entries, operator] of [
    [`${cloud} /IC [1 0 0]`, "B"],
    [`${cloud} /C [] /IC [1 0 0]`, "f"],
    ["/Border [0 0 0] /BE << /S /C /I 1 >> /IC [1 0 0]", "f"]
  ]) {
    assert.match((await synthesize(entries)).content, new RegExp(` c\\nh ${operator}\\nQ$`));
  }
  assert.equal(await synthesize(`${cloud} /C []`), null);
  assert.equal(await synthesize(`${cloud} /CA 0 /IC [1 0 0]`), null);

  for (const rectangle of [[0, 0, 1, 1], [0, 0, 0.01, 0.05], [0, 0, 120, 3]]) {
    const small = await synthesize("/Border [0 0 0] /IC [1 0 0] /BE << /S /C /I 2 >>", { rectangle });
    assert.ok(curveCount(small.content) > 0);
    assert.doesNotMatch(small.content, /NaN|Infinity/);
  }
  const reversed = await synthesize(cloud, { rectangle: [120, 80, 0, 0] });
  assert.equal(reversed.content, outline.content);
  for (const options of [
    { rectangle: [0, 0, 1000000, 1000000] },
    { limits: { maxPathVerbsPerPage: 10 } }
  ]) {
    await assert.rejects(synthesize(cloud, options), (error) =>
      error?.code === "resource-limit" && error?.details?.reason === "appearance-cloud-geometry-limit");
  }
  await assert.rejects(synthesize(cloud, { limits: { maxDecodedStreamBytes: 100 } }),
    (error) => error?.code === "resource-limit");

  const filled = await render(`${cloud} /C [0 0 1] /IC [1 0 0]`);
  assertColor(pixel(filled, 80, 50), [255, 0, 0, 255], "cloud interior");
  assertColor(pixel(filled, 18, 50), [0, 0, 0, 0], "outside annotation");
  assertColor(pixel(filled, 21, 21), [0, 0, 0, 0], "rounded cloud corner");
  assertInsideAnnotation(filled);
  assert.ok(countPixels(filled, ([r, g, b, a]) => b > 200 && r < 30 && a > 200) > 100,
    "the stroke retains its blue color");
  // Along the bottom margin, the filled silhouette alternates between lobe
  // tips and gaps. A plain rectangle or a clipped-away cloud fails this check.
  let opaque = 0, transparent = 0;
  for (let x = 30; x < 130; x += 0.25) {
    const alpha = pixel(filled, x, 20.5)[3];
    if (alpha > 200) opaque++;
    if (alpha < 20) transparent++;
  }
  assert.ok(opaque > 20 && transparent > 20, "the bottom edge has visible scallops");

  const unfilled = await render(`${cloud} /C [0 0 1]`);
  assert.equal(pixel(unfilled, 80, 50)[3], 0, "no /IC means no interior fill");
  const dashRaster = await render(`${cloud.replace("/S /S", "/S /D /D [3 2]")} /C [0 0 1]`);
  assert.ok(countPixels(dashRaster, ([,,, a]) => a > 200) < countPixels(unfilled, ([,,, a]) => a > 200) * 0.85,
    "dashes leave real gaps in the cloudy stroke");

  const inset = await render(`${cloud} /C [] /IC [1 0 0] /RD [14 16 20 12]`);
  const painted = paintedBounds(inset);
  // /RD and the half-width position the lobe centers; radius 5 expands them.
  assertNear(painted, [30, 28, 124, 68], 0.3, "asymmetric /RD stays in page coordinates without stretching");
  const thin = await render("/BS << /W 0.1 >> /BE << /S /C /I 2 >> /IC [1 0 0]", [20, 20, 21, 21]);
  assert.ok(countPixels(thin, ([,,, a]) => a > 100) > 0, "tiny clouds remain renderable");
  assertInsideAnnotation(thin, [20, 20, 21, 21]);
  console.log("Square cloudy appearance synthesis and raster tests passed");
} finally {
  hooks.deregister();
}

function fixture(entries, rectangle = [0, 0, 120, 80], objects = []) {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 100] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>" },
    { number: 4, body: tinyPdfStream("", "") },
    { number: 5, body: `<< /Type /Annot /Subtype /Square /Rect [${rectangle.join(" ")}] ${entries} >>` },
    ...objects
  ] });
}

async function synthesize(entries, { rectangle, objects, limits } = {}) {
  const document = await openNativePdfDocument({ kind: "bytes", bytes: fixture(entries, rectangle, objects) }, { limits });
  try {
    const registry = new NativePdfFormAppearanceRegistry(document);
    const [annotation] = await registry.listPageAnnotations(0);
    const appearance = await resolveNativePdfAnnotationAppearanceWithSynthesis(
      registry, new NativePdfAppearanceSynthesizer(document), annotation
    );
    return appearance ? { content: decoder.decode(appearance.decodedContent), bbox: appearance.normalAppearance.form.bbox } : null;
  } finally {
    await document.close();
  }
}

async function render(entries, rectangle = [20, 20, 140, 80]) {
  const session = await openPdf({ kind: "bytes", bytes: fixture(entries, rectangle) });
  try {
    const page = await session.compilePage(0, { optimization: "none" });
    validateHeprPageData(page);
    const invocation = page.displayProgram.groups[page.displayProgram.rootGroupIndex].commands[0];
    const program = page.displayProgram.programs[invocation.programIndex];
    assert.deepEqual(program.bounds, [0, 0, rectangle[2] - rectangle[0], rectangle[3] - rectangle[1]]);
    const offset = invocation.transformIndex * 6;
    assert.deepEqual([...page.stores.transforms.values.slice(offset, offset + 6)], [1, 0, 0, 1, rectangle[0], rectangle[1]]);
    await assert.rejects(session.compileVectorPage(0, { optimization: "none" }),
      (error) => error?.code === "unsupported-content" && error?.details?.reason === "vector-annotation-appearance");
    return await renderHeprPageToCanvas2d(page, {
      scale: 4,
      surfaceFactory(width, height) {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext("2d") };
      }
    });
  } finally {
    await session.close();
  }
}

function curveCount(content) {
  return (content.match(/ c(?:\n|$)/g) ?? []).length;
}

function pixel(result, x, y) {
  return [...result.surface.context.getImageData(Math.floor(x * result.scale),
    result.height - 1 - Math.floor(y * result.scale), 1, 1).data];
}

function assertColor(actual, expected, message) {
  assertNear(actual, expected, 3, message);
}

function assertNear(actual, expected, tolerance, message) {
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${message}: ${actual} vs ${expected}`);
  }
}

function countPixels(result, predicate) {
  const data = result.surface.context.getImageData(0, 0, result.width, result.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (predicate(data.subarray(i, i + 4))) count++;
  return count;
}

function paintedBounds(result) {
  const data = result.surface.context.getImageData(0, 0, result.width, result.height).data;
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
    if (data[(y * result.width + x) * 4 + 3] < 20) continue;
    left = Math.min(left, x / result.scale);
    right = Math.max(right, (x + 1) / result.scale);
    bottom = Math.min(bottom, (result.height - y - 1) / result.scale);
    top = Math.max(top, (result.height - y) / result.scale);
  }
  return [left, bottom, right, top];
}

function assertInsideAnnotation(result, rectangle = [20, 20, 140, 80]) {
  const bounds = paintedBounds(result);
  assert.ok(bounds[0] >= rectangle[0] && bounds[1] >= rectangle[1] &&
    bounds[2] <= rectangle[2] && bounds[3] <= rectangle[3], `${bounds} must fit ${rectangle}`);
}
