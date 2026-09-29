import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
const hooks = registerHooks({ resolve(s, c, next) {
  return next(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? `${s}.ts` : s, c);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { buildTextLod, buildTextLodAsync } = await import("../src/textGreekLod.ts");
  const { TextLodRuntime } = await import("../src/textLodCore.ts");
  const { OrderedTextLodSelection } = await import("../src/orderedTextLod.ts");
  const { VectorOrderedBatches } = await import("../src/vectorOrderedBatches.ts");
  const { VectorDrawRunCuller } = await import("../src/vectorDrawRunCulling.ts");
  const { createDefaultOptionalContentSnapshot } = await import("../src/optionalContent.ts");
  const { createOrthographicLocalToClip } = await import("../src/planarProjection.ts");
  const { WebGlFloorplanRenderer } = await import("../src/webGlFloorplanRenderer.ts");
  const { WebGpuFloorplanRenderer } = await import("../src/webGpuFloorplanRenderer.ts");
  const count = 60_000;
  const rectangle = (x0, y0, x1, y1) => ({ parent: -1, fillRule: 0,
    edges: Float32Array.of(x0,y0,x1,y0, x1,y0,x1,y1, x1,y1,x0,y1, x0,y1,x0,y0) });
  const scene = { ...createEmptyVectorScene(), textInstanceCount: count, textGlyphCount: 1, textGlyphSegmentCount: 4,
    textInstanceA: new Float32Array(count * 4), textInstanceB: new Float32Array(count * 4), textInstanceC: new Float32Array(count * 4),
    textGlyphMetaA: Float32Array.of(0,4,0,0), textGlyphMetaB: Float32Array.of(0.7,1,0,0),
    textGlyphSegmentsA: Float32Array.of(0,0,0,0, .7,0,.7,0, .7,1,.7,1, 0,1,0,1),
    textGlyphSegmentsB: Float32Array.of(.7,0,0,0, .7,1,0,0, 0,1,0,0, 0,0,0,0),
    pageCount: 1, pageRects: Float32Array.of(-1,-1,501,241), pageTextRanges: Uint32Array.of(0,count),
    bounds: { minX: -1, minY: -1, maxX: 501, maxY: 241 },
    fillPathCount: 1, fillPathMetaA: Float32Array.of(0,0,5,0), fillPathMetaB: Float32Array.of(6,1,0,1), fillPathMetaC: Float32Array.of(1,0,0,1),
    clipPaths: [rectangle(-1,-1,9,241), rectangle(0,-1,501,241)],
    optionalContent: { groups: [], conditions: [{ kind: "constant", value: true }, { kind: "constant", value: true }], order: [], radioGroups: [] },
    // The first boundary is in the middle of a baseline, around another paint.
    drawRuns: [{ kind: "text", first: 0, count: 17, clipIndex: 0, optionalContent: 0 },
      { kind: "fill", first: 0, count: 1 },
      { kind: "text", first: 17, count: count - 17, clipIndex: 1, optionalContent: 1 }] };
  scene.pageBounds = scene.bounds;
  for (let i = 0; i < count; i++) {
    scene.textInstanceA.set([1,0,0,1], i * 4);
    scene.textInstanceB.set([i % 500, Math.floor(i / 500) * 2, 0, 0], i * 4);
    scene.textInstanceC.set([0,0,0,1], i * 4);
  }
  const canonical = structuredClone(scene);
  const build = buildTextLod(scene);
  assert(build.data);
  assert.equal(build.data.runs[0].exactCount, 17, "a coarse baseline stops before the next paint");
  const asyncBuild = await buildTextLodAsync(scene);
  assert(asyncBuild.data.runs.every(r => r.exactStart >= 17 || r.exactStart + r.exactCount <= 17),
    "the asynchronous builder preserves the same paint boundaries");
  const multiply = buildTextLod({ ...scene, drawRuns: scene.drawRuns.map((r, i) => i === 0 ? { ...r, blendMode: "Multiply" } : r) });
  assert.equal(multiply.data.runs[0].eligible, false, "Multiply glyphs retain their exact per-instance blending");
  assert.throws(() => new OrderedTextLodSelection(scene, buildTextLod({ ...scene, drawRuns: undefined }).data), /paint boundary/);

  const view = { localToClip: createOrthographicLocalToClip(250,120,.02,1000,600), viewportWidth: 1000, viewportHeight: 600 };
  const selected = new TextLodRuntime(build).update(view);
  assert(selected.instanceIds.length < count / 10);
  const reversed = { ...scene, drawRuns: [...scene.drawRuns].reverse() };
  const reversedSelection = new OrderedTextLodSelection(reversed, build.data);
  reversedSelection.update(selected);
  const reversedPlan = new VectorOrderedBatches(reversed, null);
  reversedPlan.setTextSelection(reversedSelection); reversedPlan.update(reversed.drawRuns, 50);
  assert.deepEqual(reversedPlan.batches.map(b => b.kind), ["text", "fill", "text"], "canonical paint order can differ from glyph-store order");
  assert.equal(reversedPlan.uintInstances[1], 2, "reordered selection keeps its original clip");

  // Conservative culling must include the replacement rectangle, even if it
  // extends into a gap between the original transformed glyph boxes.
  const culler = new VectorDrawRunCuller(scene);
  const edgeView = { minX: 800, minY: 0, maxX: 801, maxY: 1 };
  const unclipped = { ...scene, drawRuns: scene.drawRuns.map(r => ({ ...r, clipIndex: undefined })) };
  const expanded = new VectorDrawRunCuller(unclipped);
  assert.equal(expanded.select(edgeView, .001).length, 0);
  expanded.includeTextLod({ ...build.data, runs: [{ ...build.data.runs[0], bounds: { minX: 0,minY: 0,maxX: 801,maxY: 1 } }] });
  assert(expanded.select(edgeView, .001).includes(unclipped.drawRuns[0]), "coarse bounds invalidate a prior culling result");
  culler.includeTextLod(build.data);

  let reference;
  for (const [backend, Renderer] of [["WebGL", WebGlFloorplanRenderer], ["WebGPU", WebGpuFloorplanRenderer]]) {
    const runtime = new TextLodRuntime(build), selection = new OrderedTextLodSelection(scene, build.data);
    const plan = new VectorOrderedBatches(scene, null), calls = [];
    let uploads = 0, pipeline;
    const instance = Object.assign(Object.create(Renderer.prototype), {
      scene, textInstanceCount: count, textLodRuntime: runtime, orderedTextLod: selection,
      textLodGpuActive: true, textLodMode: "auto", orderedBatches: plan, orderedRunCuller: culler,
      canvas: { width: 1000,height: 600 }, cameraCenterX: 250,cameraCenterY: 120,zoom: .02,
      rasterRenderingEnabled: false, strokeRenderingEnabled: false, textRenderingEnabled: true, fillRenderingEnabled: true,
      optionalContentVisibility: createDefaultOptionalContentSnapshot(scene), orderedCullingBounds: null,
      textInstanceIdBuffer: {}, orderedInstanceBuffer: {}, vectorClipBindGroups: [{}], frameDrawCalls: 0,
      fillPipeline: "fill",textPipeline: "text",fillBindGroup: {},textBindGroup: {},vectorOverrideColor: [0,0,0],vectorOverrideOpacity: 0,
      gl: { bindBuffer() {}, bufferData() { uploads++; } },
      gpuDevice: { queue: { writeBuffer(buffer) { if (buffer === instance.orderedInstanceBuffer) uploads++; } } },
      drawPageBackgroundContentIntoPass() {},
      drawFilledPaths(_w,_h,_x,_y,_z,first,count) { calls.push(["fill",first,count]); },
      drawTextInstances(_w,_h,_x,_y,_z,_projection,range) { calls.push(["text",range.start,range.count]); }
    });
    const pass = { setPipeline(value) { pipeline = value; }, setBindGroup() {},
      draw(_vertices,count,_firstVertex,first) { calls.push([pipeline,first,count]); } };
    function render() {
      calls.length = 0;
      if (backend === "WebGL") instance.drawSourceOrderedFrame(1000,600,instance.cameraCenterX,120,instance.zoom,null);
      else {
        instance.updateCameraUniforms(1000,600,instance.cameraCenterX,120,instance.zoom);
        assert.equal(instance.useTextInstanceIndirection, false, "ordered WebGPU IDs use the interleaved clip buffer");
        instance.drawSourceOrderedContentIntoPass(pass);
      }
      return Array.from(plan.uintInstances.subarray(0,plan.instanceCount * 2));
    }
    const first = render();
    assert.equal(uploads, 1, `${backend}: first selection uploads once`);
    assert(plan.instanceCount < count / 10, `${backend}: Auto uses coarse instances with source-ordered paints`);
    assert.deepEqual(calls.map(c => c[0]), ["text","fill","text"], `${backend}: text never crosses an intervening fill`);
    assert.equal(first[1], 1, `${backend}: coarse text retains its PDF clip`);
    assert.equal(first.at(-1), 2);
    if (reference) assert.deepEqual(first, reference, "native backends submit identical exact/coarse IDs and clips"); else reference = first;
    for (let i = 0; i < 240; i++) { instance.cameraCenterX += .01; render(); }
    assert.equal(uploads, 1, `${backend}: panning within the visibility guard does not rebuild/upload the selection`);

    instance.optionalContentVisibility = { revision: 2, layers: [], conditions: Uint8Array.of(1,0) };
    render();
    assert.deepEqual(calls.map(c => c[0]), ["text","fill"], `${backend}: hidden-layer text is excluded`);
    assert.equal(plan.instanceCount, selection.ranges[1] + 1);
    instance.optionalContentVisibility = createDefaultOptionalContentSnapshot(scene);
    instance.textLodMode = "off"; runtime.setMode("off"); render();
    assert.equal(plan.instanceCount, count + 1, `${backend}: Off restores the complete original glyph set`);
    instance.textLodMode = "auto"; runtime.setMode("auto"); render();
    assert(plan.instanceCount < count / 10);
    instance.zoom = 1; render();
    assert.equal(runtime.getStats().renderedRuns, 0, `${backend}: readable text returns to exact glyphs`);
    assert(plan.instanceCount > count / 2);
    runtime.setResourceFallback("resource-capacity"); instance.textLodGpuActive = false; render();
    assert.equal(plan.instanceCount, count + 1, `${backend}: resource fallback retains exact drawing`);
  }
  assert.deepEqual(scene, canonical, "rendering preserves canonical geometry, clips, layers and paint order");
  for (const file of ["webGlFloorplanRenderer.ts","webGpuFloorplanRenderer.ts"]) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /textLodBuildResult = scene.drawRuns \? null/, "ordered metadata alone must not disable LOD");
    assert.match(source, /textLodBuildResult = this.scenePaintVisibility.requiresCompositing \? null/,
      "compositor effects conservatively retain exact text");
    assert.match(source, /scene.drawRuns && textLodUploadData \? new OrderedTextLodSelection/,
      "ordered LOD is activated only after a successful combined texture upload");
  }
  console.log("Native ordered text LOD: paint boundaries, clipping, layers, canonical order, native parity, pan reuse, exact zoom and fallback passed.");
} finally { hooks.deregister(); }
