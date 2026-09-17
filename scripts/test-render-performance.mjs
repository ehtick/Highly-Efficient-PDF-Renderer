import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? s + ".ts" : s, c);
} });
try {
  const { VectorDrawRunCuller, vectorViewBounds } = await import("../src/vectorDrawRunCulling.ts");
  const { RenderPerformanceProbe, renderProfilingEnabled } = await import("../src/renderPerformanceProbe.ts");
  const { WebGlFloorplanRenderer } = await import("../src/webGlFloorplanRenderer.ts");
  const { WebGpuFloorplanRenderer } = await import("../src/webGpuFloorplanRenderer.ts");
  const scene = fixture();
  const culler = new VectorDrawRunCuller(scene);
  const view = { minX: -2, minY: -2, maxX: 12, maxY: 12 };
  assert.deepEqual([...culler.select(view, 0.01)], [scene.drawRuns[0], scene.drawRuns[2], scene.drawRuns[4]]);
  assert.equal(culler.select(null, 1), scene.drawRuns, "unknown perspective bounds retain all paints");
  assert.deepEqual([...culler.select({ minX: 90, minY: 90, maxX: 112, maxY: 112 }, 0.01)], [scene.drawRuns[1], scene.drawRuns[3]]);
  const overview = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  assert.equal(culler.select(overview, 0.01), scene.drawRuns, "full visibility returns the immutable source list");
  const visible = culler.visible;
  visible.push = () => { throw new Error("overview must not scan runs into a new visible list"); };
  assert.equal(culler.select({ ...overview, minX: -999 }, 0.01), scene.drawRuns);
  delete visible.push;
  assert.deepEqual([...culler.select(view, 0.01)], [scene.drawRuns[0], scene.drawRuns[2], scene.drawRuns[4]],
    "panning into a detail resumes per-run culling");
  const wide = { ...scene, drawRuns: [scene.drawRuns[0]], styles: Float32Array.of(50, 0, 0, 0, 1, 0, 0, 0) };
  assert.equal(new VectorDrawRunCuller(wide).select({ minX: 4, minY: 45, maxX: 6, maxY: 46 }, 0.01).length, 1,
    "wide strokes stay visible when their centerline is offscreen");
  const hairline = { ...wide, styles: new Float32Array(8) };
  const hairlineCuller = new VectorDrawRunCuller(hairline);
  assert.equal(hairlineCuller.select({ minX: 4, minY: 1, maxX: 6, maxY: 2 }, 1).length, 1);
  assert.equal(hairlineCuller.select({ minX: 4, minY: 1, maxX: 6, maxY: 2 }, 0.01).length, 0);
  const emptyClip = { ...scene, drawRuns: [{ ...scene.drawRuns[0], clipIndex: 0 }],
    clipPaths: [{ parent: -1, fillRule: 0, edges: new Float32Array() }] };
  assert.equal(new VectorDrawRunCuller(emptyClip).select(view, 1).length, 0);
  assert.equal(new VectorDrawRunCuller(emptyClip).select(overview, 1).length, 0,
    "full-scene reuse must not restore empty clipped paints");
  assert.deepEqual(vectorViewBounds(20, 40, 5, 6, 2), { minX: 0, minY: -4, maxX: 10, maxY: 16 });

  // Production submission paths use the filtered list, in its original order.
  const gl = Object.create(WebGlFloorplanRenderer.prototype);
  const gpu = Object.create(WebGpuFloorplanRenderer.prototype);
  const flags = { scene, orderedRunCuller: culler, orderedCullingBounds: view, zoom: 1,
    fillRenderingEnabled: true, strokeRenderingEnabled: true, textRenderingEnabled: true, rasterRenderingEnabled: true };
  Object.assign(gl, flags); Object.assign(gpu, flags);
  const calls = [];
  gl.drawPageBackgrounds = () => {};
  gl.drawVisibleSegments = (_w, _h, _x, _y, _z, range) => { calls.push(["stroke", range.start]); return range.count; };
  gl.drawTextInstances = (_w, _h, _x, _y, _z, _lod, range) => calls.push(["text", range.start]);
  gl.drawFilledPaths = (_w, _h, _x, _y, _z, first) => calls.push(["fill", first]);
  gl.drawRasterLayerAtIndex = index => calls.push(["raster", index]);
  gl.drawSourceOrderedContent(14, 14, 5, 5, 1);
  assert.deepEqual(calls, [["stroke", 0], ["fill", 0], ["text", 0]]);
  assert.equal(gl.orderedRunsCulled, true);
  calls.length = 0;
  Object.assign(gpu, { fillPipeline: "fill", strokePipeline: "stroke", textPipeline: "text", rasterPipeline: "raster",
    fillBindGroup: {}, strokeBindGroupAll: {}, textBindGroup: {}, vectorClipBindGroups: [{}], rasterLayerResources: [{}] });
  gpu.drawPageBackgroundContentIntoPass = () => {};
  let pipeline;
  gpu.drawSourceOrderedContentIntoPass({ setPipeline(p) { pipeline = p; }, setBindGroup() {},
    draw(_vertices, _count, _firstVertex, first) { calls.push([pipeline, first]); } });
  assert.deepEqual(calls, [["stroke", 0], ["fill", 0], ["text", 0]]);

  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
  const previousSetting = Object.getOwnPropertyDescriptor(globalThis, "__HEPR_PROFILE__");
  const previousSkip = Object.getOwnPropertyDescriptor(globalThis, "__HEPR_PROFILE_SKIP__");
  const previousUsage = Object.getOwnPropertyDescriptor(globalThis, "GPUBufferUsage");
  const previousMapMode = Object.getOwnPropertyDescriptor(globalThis, "GPUMapMode");
  const originalInfo = console.info;
  let now = 1000;
  let clockReads = 0;
  const logs = [];
  console.info = (...args) => logs.push(args);
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => { clockReads++; return now; } } });
  const queries = [], deleted = [], ext = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 };
  let available = false, disjoint = false;
  const context = { QUERY_RESULT_AVAILABLE: 3, QUERY_RESULT: 4, CURRENT_QUERY: 5,
    getExtension() { return ext; }, getParameter() { return disjoint; }, getQuery() { return null; },
    createQuery() { const query = {}; queries.push(query); return query; }, beginQuery() {}, endQuery() {},
    deleteQuery(q) { deleted.push(q); }, getQueryParameter(_q, kind) {
      if (kind === 3) return available;
      assert(available, "query results must never be read before they are available"); return 2_000_000;
    } };
  const probe = new RenderPerformanceProbe("test-webgl");
  try {
    globalThis.__HEPR_PROFILE__ = false;
    globalThis.__HEPR_PROFILE_SKIP__ = "text";
    assert.equal(renderProfilingEnabled(), false);
    probe.begin(scene, {}, context); probe.end();
    assert.equal(probe.mark(), -1);
    probe.phase("strokeLod", 0); probe.count("batchRebuilds"); probe.draw("text", 3);
    assert.equal(probe.skips("text"), false, "disabled profiling must never hide content");
    assert.equal(clockReads, 0, "disabled phase measurements do not read the clock");
    assert.equal(logs.length, 0); assert.equal(queries.length, 0);
    delete globalThis.__HEPR_PROFILE_SKIP__;
    globalThis.__HEPR_PROFILE__ = true;
    const measuredFrame = (lodMs, submitMs) => {
      let start = probe.mark(); now += lodMs; probe.phase("strokeLod", start);
      start = probe.mark(); now += submitMs; probe.phase("orderedSubmit", start);
      probe.draw("stroke", 50); probe.draw("fill", 2); probe.draw("text", 3);
      probe.orderedRuns(3, 3); probe.end();
    };
    probe.begin(scene, {}, context); probe.count("batchRebuilds"); probe.count("instanceUploadBytes", 440); measuredFrame(1, 3);
    now = 2000; available = true; probe.begin(scene, {}, context); measuredFrame(2, 4);
    now = 3100; probe.begin(scene, {}, context); measuredFrame(3, 5);
    const report = JSON.parse(logs.find(([label]) => label === "[HEPR profile frame]")[1]);
    assert.equal(report.cpuSubmitMs.median, 6);
    assert.equal(report.gpuMs.median, 2);
    assert.equal(report.orderedDrawRequests, 3);
    assert.deepEqual(report.cpuPhasesMs.strokeLod, { median: 2, p95: 3 });
    assert.deepEqual(report.cpuPhasesMs.orderedSubmit, { median: 4, p95: 5 });
    assert.deepEqual(report.cpuPhasesMs.batchPlan, { median: 0, p95: 0 }, "unexecuted phases count as zero");
    assert.deepEqual(report.workPerFrame.batchRebuilds, { mean: 0.33, max: 1 });
    assert.deepEqual(report.workPerFrame.instanceUploadBytes, { mean: 146.67, max: 440 });
    assert.deepEqual(report.orderedDrawsByKind, { stroke: { draws: 1, instances: 50 },
      fill: { draws: 1, instances: 2 }, text: { draws: 1, instances: 3 } });
    assert(!JSON.stringify(logs).includes(scene.sourceLabel), "logs omit document names and contents");
    disjoint = true; now += 600; probe.begin(scene, {}, context); probe.end();
    assert.equal(deleted.length, queries.length, "disjoint timer samples are discarded");
    probe.dispose();

    const isolate = new RenderPerformanceProbe("skip-test");
    globalThis.__HEPR_PROFILE_SKIP__ = "text";
    isolate.begin(scene, {});
    assert(isolate.skips("text"));
    assert.equal(isolate.skips("fill"), false);
    gl.performanceProbe = isolate; gpu.performanceProbe = isolate;
    calls.length = 0;
    gl.drawSourceOrderedContent(14, 14, 5, 5, 1);
    assert.deepEqual(calls, [["stroke", 0], ["fill", 0]]);
    calls.length = 0;
    gpu.drawSourceOrderedContentIntoPass({ setPipeline(p) { pipeline = p; }, setBindGroup() {},
      draw(_vertices, _count, _firstVertex, first) { calls.push([pipeline, first]); } });
    assert.deepEqual(calls, [["stroke", 0], ["fill", 0]]);
    isolate.end();
    assert.equal(isolate.skips("text"), false, "the diagnostic skip applies only during a profiled frame");
    globalThis.__HEPR_PROFILE_SKIP__ = "unsupported";
    isolate.begin(scene, {}); assert.equal(isolate.skips("text"), false); isolate.end();
    delete globalThis.__HEPR_PROFILE_SKIP__;
    isolate.dispose();

    // WebGPU query readback is asynchronous and owns its resources until completion.
    globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8 };
    globalThis.GPUMapMode = { READ: 1 };
    const resources = [], encodes = []; let release;
    const device = { features: new Set(["timestamp-query"]),
      createQuerySet() { const q = { destroy() { q.destroyed = true; } }; resources.push(q); return q; },
      createBuffer() {
        const b = { destroy() { b.destroyed = true; }, unmap() {},
          mapAsync() { return new Promise(resolve => { release = resolve; }); },
          getMappedRange() { return BigUint64Array.of(1_000_000n, 4_000_000n).buffer; } };
        resources.push(b); return b;
      } };
    const gpuProbe = new RenderPerformanceProbe("test-webgpu");
    gpuProbe.begin(scene, {});
    assert(gpuProbe.gpuPass(device).timestampWrites);
    gpuProbe.resolveGpu({ resolveQuerySet() { encodes.push("resolve"); }, copyBufferToBuffer() { encodes.push("copy"); } });
    gpuProbe.end();
    assert.deepEqual(encodes, ["resolve", "copy"]);
    assert(resources.every(r => !r.destroyed));
    release(); await new Promise(resolve => setImmediate(resolve));
    assert(resources.every(r => r.destroyed));
    now += 2100; gpuProbe.begin(scene, {}); gpuProbe.end();
    const gpuReport = JSON.parse(logs.filter(([label]) => label === "[HEPR profile frame]").at(-1)[1]);
    assert.equal(gpuReport.gpuMs.median, 3);
    // Results from the previous diagnostic configuration must not pollute an A/B capture.
    now += 600; gpuProbe.begin(scene, {}); gpuProbe.gpuPass(device);
    gpuProbe.resolveGpu({ resolveQuerySet() {}, copyBufferToBuffer() {} }); gpuProbe.end();
    globalThis.__HEPR_PROFILE_SKIP__ = "text";
    now += 10; gpuProbe.begin(scene, {}); gpuProbe.end();
    release(); await new Promise(resolve => setImmediate(resolve));
    now += 2100; gpuProbe.begin(scene, {}); gpuProbe.end();
    const isolatedReport = JSON.parse(logs.filter(([label]) => label === "[HEPR profile frame]").at(-1)[1]);
    assert.equal(isolatedReport.gpuSamples, 0);
    assert.deepEqual(isolatedReport.skippedKinds, ["text"]);
    gpuProbe.dispose();
  } finally {
    probe.dispose(); console.info = originalInfo;
    for (const [key, descriptor] of [["performance", previousPerformance], ["__HEPR_PROFILE__", previousSetting],
      ["__HEPR_PROFILE_SKIP__", previousSkip], ["GPUBufferUsage", previousUsage], ["GPUMapMode", previousMapMode]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
  console.log("Ordered draw culling and opt-in asynchronous render profiling passed");
} finally { hooks.deregister(); }

function fixture() {
  return { sourceLabel: "PRIVATE DOCUMENT NAME", pageCount: 2, segmentCount: 2, fillPathCount: 1, textInstanceCount: 1,
    drawRuns: [{ kind: "stroke", first: 0, count: 1 }, { kind: "stroke", first: 1, count: 1 },
      { kind: "fill", first: 0, count: 1 }, { kind: "raster", first: 0, count: 1 }, { kind: "text", first: 0, count: 1 }],
    endpoints: Float32Array.of(0, 0, 10, 0, 100, 100, 110, 100),
    primitiveMeta: Float32Array.of(10, 0, 0, 1, 110, 100, 0, 1), styles: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0),
    fillPathMetaA: Float32Array.of(0, 4, 0, 0), fillPathMetaB: Float32Array.of(10, 10, 0, 0),
    textInstanceA: Float32Array.of(0, 1, -1, 0), textInstanceB: Float32Array.of(10, 0, 0, 0),
    textGlyphMetaA: Float32Array.of(0, 4, 0, 0), textGlyphMetaB: Float32Array.of(10, 10, 0, 0),
    rasterLayers: [{ matrix: Float32Array.of(10, 0, 0, 10, 100, 100) }] };
}
