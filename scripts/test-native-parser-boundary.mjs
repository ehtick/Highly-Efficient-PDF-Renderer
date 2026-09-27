import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";

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
  const [{ extractPdfPageScenes, deriveSceneTextContentFromIndex }, objectGeneratorModule] = await Promise.all([
    import("../src/pdfVectorExtractor.ts"),
    import("../src/pdfObjectGenerator.ts")
  ]);
  assert.equal(typeof objectGeneratorModule.loadPdfSceneFromSource, "function");
  assert.deepEqual(
    deriveSceneTextContentFromIndex(createIndexedTextScene(), 0),
    [
      { text: "AB", minX: 0, minY: 0, maxX: 3, maxY: 1, pageIndex: 0 },
      { text: "CD", minX: 10, minY: 0, maxX: 13, maxY: 1, pageIndex: 0 }
    ]
  );

  // Node now launches the real dense worker through worker_threads instead of
  // consulting globalThis.Worker. Exercise that production boundary with a
  // valid native-compatible PDF; a browser-Worker stub would no longer prove
  // that the worker entry and its imports remain dependency-free.
  const denseProgress = [];
  const scenes = await extractPdfPageScenes(toArrayBuffer(createVectorOptimizationPdf()), {
    onProgress: (event) => denseProgress.push(event)
  });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].pageCount, 1);
  assert.ok(
    denseProgress.some(({ executionPath }) => executionPath === "dense-vector-worker"),
    "native-compatible parsing must execute in the direct Node dense worker"
  );

  const formBytes = createSimpleFormPdf();
  const formBuffer = toArrayBuffer(formBytes);
  const formSnapshot = new Uint8Array(formBuffer).slice();
  const formProgress = [];
  const nativeFullScenes = await extractPdfPageScenes(formBuffer, {
    enableSegmentMerge: false,
    enableInvisibleCull: true,
    onProgress: (event) => formProgress.push(event)
  });
  assert.equal(nativeFullScenes.length, 1);
  assert.equal(nativeFullScenes[0].fillPathCount, 1);
  assert.ok(
    formProgress.some(({ executionPath }) => executionPath === "dense-vector-worker"),
    "auto mode must attempt dense compilation first"
  );
  assert.ok(
    formProgress.some(({ executionPath }) => executionPath === "worker"),
    "a dense rejection must continue in the full native Node worker"
  );
  assert.deepEqual(
    new Uint8Array(formBuffer),
    formSnapshot,
    "native fallback parsing must not detach or mutate caller bytes"
  );

  const forcedNativeProgress = [];
  const forcedNativeScenes = await extractPdfPageScenes(toArrayBuffer(formBytes), {
    pdfFastPath: "off",
    onProgress: (event) => forcedNativeProgress.push(event)
  });
  assert.equal(forcedNativeScenes.length, 1);
  assert.equal(forcedNativeScenes[0].fillPathCount, 1);
  assert.ok(
    forcedNativeProgress.every(({ executionPath }) => executionPath !== "dense-vector-worker"),
    "pdfFastPath=off must skip only the dense worker"
  );
  assert.ok(
    forcedNativeProgress.some(({ executionPath }) => executionPath === "worker"),
    "pdfFastPath=off must retain the full native Node worker"
  );

  const optimizationBytes = createVectorOptimizationPdf();
  const [unoptimizedScene] = await extractPdfPageScenes(toArrayBuffer(optimizationBytes), {
    pdfFastPath: "off",
    enableSegmentMerge: false,
    enableInvisibleCull: false
  });
  const [mergeOnlyScene] = await extractPdfPageScenes(toArrayBuffer(optimizationBytes), {
    pdfFastPath: "off",
    enableSegmentMerge: true,
    enableInvisibleCull: false
  });
  const [cullOnlyScene] = await extractPdfPageScenes(toArrayBuffer(optimizationBytes), {
    pdfFastPath: "off",
    enableSegmentMerge: false,
    enableInvisibleCull: true
  });
  assert.equal(unoptimizedScene.sourceSegmentCount, 3);
  assert.equal(unoptimizedScene.mergedSegmentCount, 3);
  assert.equal(unoptimizedScene.segmentCount, 3);
  assert.equal(mergeOnlyScene.mergedSegmentCount, 2, "merge must remain independently enabled");
  assert.equal(mergeOnlyScene.segmentCount, 2);
  assert.equal(cullOnlyScene.mergedSegmentCount, 3, "culling must not implicitly enable merge");
  assert.equal(cullOnlyScene.segmentCount, 1, "culling must remain independently enabled");

  const nativeProgress = [];
  const selectedScenes = await extractPdfPageScenes(toArrayBuffer(createTwoPagePdf()), {
    pdfFastPath: "off",
    pages: "2",
    onProgress: (event) => nativeProgress.push(event)
  });
  assert.equal(selectedScenes.length, 1);
  assert.deepEqual(selectedScenes[0].pageBounds, { minX: 0, minY: 0, maxX: 40, maxY: 50 });
  assert.ok(nativeProgress.some(({ executionPath }) => executionPath === "worker"));
  for (let index = 1; index < nativeProgress.length; index += 1) {
    assert.ok(nativeProgress[index].value >= nativeProgress[index - 1].value);
  }

  const abortController = new AbortController();
  const abortReason = new Error("cancel native tier");
  abortController.abort(abortReason);
  await assert.rejects(
    extractPdfPageScenes(
      toArrayBuffer(createSimpleFormPdf()),
      { pdfFastPath: "off" },
      abortController.signal
    ),
    (error) => error === abortReason
  );

  await assert.rejects(
    extractPdfPageScenes(toArrayBuffer(createUnsupportedFilterPdf()), { pdfFastPath: "off" }),
    (error) => {
      assert.equal(error?.name, "PdfError");
      assert.equal(error?.code, "unsupported-filter");
      assert.match(error?.message ?? "", /Crypt|filter/i);
      return true;
    }
  );

  console.log("Native parser boundary passed.");
} finally {
  hooks.deregister();
}

function createSimpleFormPdf() {
  return writeTinyPdf({
    objects: [
      { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
      {
        number: 3,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>"
      },
      { number: 4, body: tinyPdfStream("", "/Fm Do") },
      {
        number: 5,
        body: tinyPdfStream(
          "/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Resources << >>",
          "1 0 0 rg 0 0 20 20 re f"
        )
      }
    ]
  });
}

function createUnsupportedFilterPdf() {
  return writeTinyPdf({
    objects: [
      { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
      {
        number: 3,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>"
      },
      { number: 4, body: tinyPdfStream("/Filter /Crypt", "") }
    ]
  });
}

function createVectorOptimizationPdf() {
  return writeTinyPdf({
    objects: [
      { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
      {
        number: 3,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>"
      },
      {
        number: 4,
        body: tinyPdfStream("", "0 0 m 5 0 l 10 0 l S 0 0 m 10 0 l S")
      }
    ]
  });
}

function createTwoPagePdf() {
  return writeTinyPdf({
    objects: [
      { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { number: 2, body: "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>" },
      {
        number: 3,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 30] /Resources << >> /Contents 4 0 R >>"
      },
      { number: 4, body: tinyPdfStream("", "0 0 10 10 re f") },
      {
        number: 5,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 50] /Resources << >> /Contents 6 0 R >>"
      },
      { number: 6, body: tinyPdfStream("", "0 0 20 20 re f") }
    ]
  });
}

function createIndexedTextScene() {
  return {
    textIndex: {
      version: 2,
      pages: [{
        text: "AB CD",
        charInstance: Int32Array.of(0, 1, -1, 2, 3),
        fallbackQuads: new Float32Array(0)
      }]
    },
    textInstanceA: Float32Array.of(
      1, 0, 0, 1,
      1, 0, 0, 1,
      1, 0, 0, 1,
      1, 0, 0, 1
    ),
    textInstanceB: Float32Array.of(
      0, 0, 0, 0,
      2, 0, 0, 0,
      10, 0, 0, 0,
      12, 0, 0, 0
    ),
    textGlyphMetaA: Float32Array.of(0, 0, 0, 0),
    textGlyphMetaB: Float32Array.of(1, 1, 0, 0)
  };
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
