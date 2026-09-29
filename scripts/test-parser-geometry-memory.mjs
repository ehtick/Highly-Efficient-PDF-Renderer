import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !specifier.endsWith(".ts")
    ? `${specifier}.ts` : specifier, context);
} });
const nativeFloat32Array = Float32Array;
const transferDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transferToFixedLength");
const strokeKeys = ["endpoints", "primitiveMeta", "primitiveBounds", "styles"];
const bytes = values => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);

try {
  const [{ compileDensePdfContent }, { lowerRetainedPageToVectorScene }, data] = await Promise.all([
    import("../src/pdf/nativeContentCompiler.ts"), import("../src/retainedVectorPage.ts"), import("../src/heprDocumentData.ts")
  ]);
  const fillSource = new TextEncoder().encode(Array.from({ length: 10_000 }, (_, index) =>
    `${index % 100} ${Math.floor(index / 100)} .5 .5 re f`).join("\n"));
  const compileFills = () => compileDensePdfContent(fillSource, {
    output: "geometry", pageMatrix: [1, 0, 0, 1, 0, 0],
    pageBounds: { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
    enableSegmentMerge: true, enableInvisibleCull: true, yieldIntervalMs: 4
  });
  const fillKeys = ["fillPathMetaA", "fillPathMetaB", "fillPathMetaC", "fillSegmentsA", "fillSegmentsB"];
  const { result: fills, stats: fillStats } = await measure(compileFills);
  assert.equal(fills.fillPathCount, 10_000);
  assert.equal(fills.fillSegmentCount, 40_000);
  const hash = createHash("sha256");
  for (const key of fillKeys) { hash.update(key); hash.update(bytes(fills[key])); }
  // Captured from the original slice-based compiler on this synthetic input.
  assert.equal(hash.digest("hex"), "086138440b137ce4160bda8c2a58624dc54f537e2912033473ef8d3648477edf");
  const fillBytes = fillKeys.reduce((sum, key) => sum + fills[key].byteLength, 0);
  assert.equal(fillBytes, 1_760_000);
  if (transferDescriptor) assert.equal(fillStats.sliceBytes, 0, "owned fill stores transfer without finalization copies");
  await withoutTransfer(async () => {
    const { result: fallback, stats } = await measure(compileFills);
    for (const key of fillKeys) assert.deepEqual(bytes(fallback[key]), bytes(fills[key]), `${key}: fallback preserves every bit`);
    assert.equal(stats.sliceBytes, fillBytes, "older runtimes retain the bounded compatibility copy");
  });

  const allocationSummaries = [];
  for (const count of [0, 1, 4096, 4097, 20_003]) {
    const page = strokePage(data, count), unchanged = structuredClone(page), expected = referenceStrokes(page);
    const { result: scene, stats } = await measure(() => lowerRetainedPageToVectorScene(page, { signal: new AbortController().signal }));
    assert.equal(scene.segmentCount, count);
    for (const key of strokeKeys) {
      assert.deepEqual(bytes(scene[key]), bytes(expected[key]), `${count} strokes: ${key} retains double-precision transform semantics`);
      assert.equal(scene[key].byteLength, scene[key].buffer.byteLength, "final stores have no unused capacity");
    }
    assert.deepEqual(page, unchanged, "lowering never transfers or edits the reusable source stores");
    if (count) {
      assert.deepEqual(scene.drawRuns, [{ kind: "stroke", first: 0, count, clipIndex: 0 }]);
      assert.deepEqual(scene.clipPaths, [{ parent: -1, fillRule: 0,
        edges: new Float32Array([0, 0, 100, 0, 100, 0, 100, 100, 100, 100, 0, 100, 0, 100, 0, 0]) }]);
      assert.equal(scene.maxHalfWidth, expected.maxHalfWidth);
    }
    assert(stats.boxedFinalFloats <= 32, "stroke-sized boxed arrays never reach Float32Array.from");
    const outputBytes = count * 64;
    assert(stats.largeAllocationBytes <= outputBytes * 2 + 4 * 65_536,
      "typed staging plus final storage stays within two payloads and bounded chunk slack");
    if (count === 20_003) {
      assert(expected.roundingSensitiveBounds > 0, "fixture detects premature Float32 rounding before bounds expansion");
      if (transferDescriptor) assert.equal(stats.releasedBytes, Math.ceil(count / 4096) * 4 * 65_536,
        "copied chunks release their owned backing stores immediately");
    }
    allocationSummaries.push({ count, outputBytes, typedAllocationBytes: stats.largeAllocationBytes,
      boxedFinalFloats: stats.boxedFinalFloats, releasedBytes: stats.releasedBytes });
    if ([1, 4097].includes(count)) await withoutTransfer(async () => {
      const fallback = await lowerRetainedPageToVectorScene(page, { signal: new AbortController().signal });
      for (const key of strokeKeys) assert.deepEqual(bytes(fallback[key]), bytes(scene[key]));
      assert.deepEqual(fallback.drawRuns, scene.drawRuns); assert.deepEqual(fallback.clipPaths, scene.clipPaths);
    });
  }
  const page = strokePage(data, 4097);
  await assert.rejects(lowerRetainedPageToVectorScene(page, { signal: AbortSignal.abort() }));
  await assert.rejects(lowerRetainedPageToVectorScene(page, { signal: new AbortController().signal, maxPrimitives: 4096 }),
    error => error.code === "resource-limit");
  console.log("Parser geometry memory regression passed.", JSON.stringify({ fillBytes, fillSliceBytes: fillStats.sliceBytes, allocationSummaries }));
} finally {
  hooks.deregister();
}

async function withoutTransfer(action) {
  if (transferDescriptor) Object.defineProperty(ArrayBuffer.prototype, "transferToFixedLength", { ...transferDescriptor, value: undefined });
  try { return await action(); }
  finally { if (transferDescriptor) Object.defineProperty(ArrayBuffer.prototype, "transferToFixedLength", transferDescriptor); }
}

async function measure(action) {
  const stats = { sliceBytes: 0, boxedFinalFloats: 0, largeAllocationBytes: 0, releasedBytes: 0 };
  const slice = nativeFloat32Array.prototype.slice;
  const transfer = ArrayBuffer.prototype.transferToFixedLength;
  nativeFloat32Array.prototype.slice = function (...args) {
    const result = slice.apply(this, args); stats.sliceBytes += result.byteLength; return result;
  };
  globalThis.Float32Array = new Proxy(nativeFloat32Array, {
    construct(target, args) {
      const result = Reflect.construct(target, args);
      if (typeof args[0] === "number" && result.byteLength > 1024) stats.largeAllocationBytes += result.byteLength;
      return result;
    },
    get(target, property) {
      if (property === "from") return (source, ...args) => {
        if (Array.isArray(source)) stats.boxedFinalFloats += source.length;
        return target.from(source, ...args);
      };
      return Reflect.get(target, property);
    }
  });
  if (transfer) ArrayBuffer.prototype.transferToFixedLength = function (length) {
    if (length === 0) stats.releasedBytes += this.byteLength;
    return transfer.call(this, length);
  };
  try { return { result: await action(), stats }; }
  finally {
    globalThis.Float32Array = nativeFloat32Array;
    nativeFloat32Array.prototype.slice = slice;
    if (transfer) ArrayBuffer.prototype.transferToFixedLength = transfer;
  }
}

function strokePage(data, count) {
  const page = data.createEmptyHeprPageData({ sourcePageIndex: 0, mediaBox: [0, 0, 100, 100], cropBox: [0, 0, 100, 100],
    bleedBox: null, trimBox: null, artBox: null, rotation: 0, userUnit: 1, width: 100, height: 100 });
  page.stores.transforms.values = new Float32Array([1, 0, 0, 1, 0, 0, .6, .8, -.8, .6, 123456.7, -98765.4]);
  const strokes = page.stores.strokes;
  for (const key of strokeKeys) strokes[key] = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    const i = index * 4, x = (index % 101) * .1234567, y = (index % 97) * -.7654321;
    strokes.endpoints.set([x, y, x + .071234, y - .052345], i);
    strokes.primitiveMeta.set([x + .532167, y + .941234, index % 2, (index % 8) * 2 + .625], i);
    strokes.styles.set([.0001 + (index % 23) * .010007, .1, .2, .3], i);
  }
  Object.assign(page.stores.colors, { spaceKinds: new Uint8Array([data.HEPR_COLOR_SPACE_KIND.DeviceRgb]),
    componentCounts: new Uint8Array([3]), alternateSpaceIndices: new Int32Array([-1]), functionIndices: new Int32Array([-1]),
    parameterOffsets: new Uint32Array([0, 3]), parameters: new Float32Array([.12345, .54321, .98765]),
    nameOffsets: new Uint32Array([0, 0]), profileOffsets: new Uint32Array([0, 0]), lookupOffsets: new Uint32Array([0, 0]),
    iccModes: new Uint8Array([0]), iccTransformOffsets: new Uint32Array([0, 0]) });
  Object.assign(page.stores.paints, { kinds: new Uint8Array([data.HEPR_PAINT_KIND.SolidColor]), resourceIndices: new Uint32Array([0]),
    alphas: new Float32Array([.375]), overprint: new Uint8Array([0]), overprintModes: new Uint8Array([0]),
    patternTransformIndices: new Int32Array([-1]), patternBasePaintIndices: new Int32Array([-1]) });
  Object.assign(page.stores.paths, { pathVerbOffsets: new Uint32Array([0, 5]), verbs: new Uint8Array([0, 1, 1, 1, 4]),
    verbCoordinateOffsets: new Uint32Array([0, 2, 4, 6, 8, 8]), coordinates: new Float32Array([0, 0, 100, 0, 100, 100, 0, 100]),
    bounds: new Float32Array([0, 0, 100, 100]), flags: new Uint8Array([0]) });
  page.stores.clips = { parentIndices: new Int32Array([-1]), firstPaths: new Uint32Array([0]), pathCounts: new Uint32Array([1]),
    firstGlyphs: new Uint32Array([0]), glyphCounts: new Uint32Array([0]), fillRules: new Uint8Array([0]), transformIndices: new Uint32Array([0]) };
  if (count) page.displayProgram.groups[0].commands.push({ kind: "draw", source: "stroke-segments", first: 0, count,
    paintIndex: 0, transformIndex: 1, clipIndex: 0, optionalContentIndex: -1, markedContentIndex: -1, sourceOffset: -1, sourceLength: -1 });
  return page;
}

function referenceStrokes(page) {
  const result = Object.fromEntries(strokeKeys.map(key => [key, []])), store = page.stores.strokes;
  const matrix = Array.from(page.stores.transforms.values.subarray(6));
  const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  let maxHalfWidth = 0, roundingSensitiveBounds = 0;
  for (let i = 0; i < store.endpoints.length; i += 4) {
    const p0 = point(store.endpoints[i], store.endpoints[i + 1]), c = point(store.endpoints[i + 2], store.endpoints[i + 3]);
    const p1 = point(store.primitiveMeta[i], store.primitiveMeta[i + 1]);
    const half = store.styles[i] * Math.hypot(matrix[0], matrix[1]), flags = Math.floor(store.primitiveMeta[i + 3] / 2);
    result.endpoints.push(...p0, ...c);
    result.primitiveMeta.push(...p1, store.primitiveMeta[i + 2], flags * 2 + (store.primitiveMeta[i + 3] - flags * 2) * page.stores.paints.alphas[0]);
    result.styles.push(half, ...page.stores.colors.parameters);
    const bound = Math.min(p0[0], c[0], p1[0]) - half;
    if (Math.fround(bound) !== Math.fround(Math.min(Math.fround(p0[0]), Math.fround(c[0]), Math.fround(p1[0])) - half)) roundingSensitiveBounds++;
    result.primitiveBounds.push(bound, Math.min(p0[1], c[1], p1[1]) - half,
      Math.max(p0[0], c[0], p1[0]) + half, Math.max(p0[1], c[1], p1[1]) + half);
    maxHalfWidth = Math.max(maxHalfWidth, half);
  }
  return { ...Object.fromEntries(strokeKeys.map(key => [key, Float32Array.from(result[key])])), maxHalfWidth, roundingSensitiveBounds };
}
