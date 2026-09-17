import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? s + ".ts" : s, c);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { VectorOrderedBatches } = await import("../src/vectorOrderedBatches.ts");
  const { VectorDrawRunCuller } = await import("../src/vectorDrawRunCulling.ts");
  const { setStrokePaintOrigins } = await import("../src/vectorStrokePaintOrder.ts");
  const { WebGlFloorplanRenderer } = await import("../src/webGlFloorplanRenderer.ts");
  const { WebGpuFloorplanRenderer } = await import("../src/webGpuFloorplanRenderer.ts");

  const scene = makePages([0, 100, 200]);
  const plan = new VectorOrderedBatches(scene, null);
  plan.update(scene.drawRuns);
  const original = paints(plan);
  assert.equal(plan.batches.length, 15);
  assert(plan.update(scene.drawRuns, 0.1));
  assert.equal(plan.batches.length, 7, "three pages share stroke, fill, and text draws; image textures remain separate");
  assert.deepEqual(paints(plan).slice().sort(), original.slice().sort(), "batching keeps every primitive and its clip root");
  for (let page = 0; page < 3; page++) assertPageOrder(plan, original, [page]);
  assert.deepEqual([...plan.floatInstances.slice(0, plan.instanceCount * 2)], [...plan.uintInstances.slice(0, plan.instanceCount * 2)]);
  assert.equal(plan.update(scene.drawRuns, 0.11), false, "zoom within the same safe partition reuses instance data");
  assert(plan.update(scene.drawRuns, 0.2), "a new AA bucket reevaluates within-page dependencies");
  assert(plan.update(scene.drawRuns, 20), "screen-space coverage can connect formerly independent pages");
  assert.deepEqual(paints(plan), original, "overlapping AA/hairline coverage retains global source order");
  assert(plan.update(scene.drawRuns, 0.1));
  assert.equal(plan.batches.length, 7);
  assert(plan.update(scene.drawRuns, null));
  assert.deepEqual(paints(plan), original, "unknown projection scale restores global order");

  const single = makePages([0]);
  single.fillPathMetaA[2] = 100; single.fillPathMetaB[0] = 110;
  const singlePlan = new VectorOrderedBatches(single, null);
  singlePlan.update(single.drawRuns, 0.1);
  assert.equal(singlePlan.batches.length, 4, "strokes share a draw across a disjoint fill on the same page");
  assert.deepEqual(paints(singlePlan), ["stroke:0:0", "stroke:1:0", "fill:0:0", "text:0:0", "raster:0:0"]);
  assert.equal(singlePlan.update(single.drawRuns, 0.11), false);
  assert(singlePlan.update(single.drawRuns, 20), "growing AA refreshes order even though the page group is unchanged");
  assert.equal(singlePlan.batches.length, 5, "AA overlap prevents the within-page swap");
  assert(singlePlan.update(single.drawRuns, 0.1));
  assert.equal(singlePlan.batches.length, 4, "zooming back restores safe batching");

  // Page rectangles are only a hint: actual content can extend beyond them.
  // A and B overlap; C is independent and can still be batched with that stream.
  const overflow = makePages([0, 100, 300]);
  overflow.fillPathMetaB[0] = 110;
  const overlapping = new VectorOrderedBatches(overflow, null);
  overlapping.update(overflow.drawRuns);
  const overflowOrder = paints(overlapping);
  overlapping.update(overflow.drawRuns, 0.1);
  assertPageOrder(overlapping, overflowOrder, [0]);
  assertPageOrder(overlapping, overflowOrder, [1]);
  assertOverlapOrder(overlapping, overflowOrder, overflow);
  assertPageOrder(overlapping, overflowOrder, [2]);
  assert(overlapping.batches.length < 15, "independent pages still batch when other pages overlap");

  const chain = makePages([0, 100, 200]);
  chain.fillPathMetaB[0] = 110;
  chain.fillPathMetaB[4] = 210;
  assertOverlappingPaints(chain);

  const unknown = makePages([0, 100]);
  unknown.textInstanceA[0] = NaN;
  assertOverlappingPaints(unknown);
  const gradient = makePages([0, 100]);
  gradient.drawRuns.splice(1, 0, { kind: "gradient-fill", first: 0, count: 1 });
  assertOverlappingPaints(gradient);

  // A glyph transform, a wide stroke, and an image can each cross a page gap.
  for (const kind of ["text", "stroke", "raster"]) {
    const crossing = makePages([0, 100]);
    if (kind === "text") crossing.textInstanceA[0] = 110;
    if (kind === "stroke") crossing.styles[0] = 110;
    if (kind === "raster") crossing.rasterLayers[0].matrix[0] = 110;
    assertOverlappingPaints(crossing);
  }

  // Vector clips bound even very long primitives; different clip roots can
  // share a draw, including parent/child intersections.
  const clipped = makePages([0, 100]);
  clipped.clipPaths = [rectangle(-1000, -1000, 1000, 1000), rectangle(0, 0, 10, 10, 0), rectangle(100, 0, 110, 10, 0)];
  clipped.drawRuns.forEach((run, index) => { run.clipIndex = Math.floor(index / 5) + 1; });
  clipped.fillPathMetaB[0] = 110;
  const clippedPlan = new VectorOrderedBatches(clipped, null);
  clippedPlan.update(clipped.drawRuns);
  const clippedOrder = paints(clippedPlan);
  clippedPlan.update(clipped.drawRuns, 0.1);
  assert.equal(clippedPlan.batches.length, 6);
  assertPageOrder(clippedPlan, clippedOrder, [0]);
  assertPageOrder(clippedPlan, clippedOrder, [1]);
  const culler = new VectorDrawRunCuller(clipped);
  assert.equal(culler.select({ minX: 40, minY: 0, maxX: 60, maxY: 10 }, 0.1).length, 0);
  assert.deepEqual(culler.select({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.1), clipped.drawRuns.slice(0, 5));
  assert.deepEqual(culler.select({ minX: 100, minY: 0, maxX: 110, maxY: 10 }, 0.1), clipped.drawRuns.slice(5));
  const unclippedCuller = new VectorDrawRunCuller(scene);
  const gap = { minX: 40, minY: 0, maxX: 60, maxY: 10 };
  assert.equal(unclippedCuller.select(gap, 0.1).length, 0);
  assert(unclippedCuller.select(gap, 20).length > 0, "changing AA scale refreshes cached culling bounds");
  assert.equal(unclippedCuller.select(gap, 0.1).length, 0);

  // All LOD levels must participate in dependency bounds, including levels
  // that are not currently selected. Their geometry can extend farther.
  const lodScene = makePages([0, 100]);
  const coarse = { ...lodScene, endpoints: lodScene.endpoints.slice(), primitiveMeta: lodScene.primitiveMeta.slice() };
  coarse.endpoints[2] = coarse.primitiveMeta[0] = 110;
  setStrokePaintOrigins(coarse, Uint32Array.from([0, 1, 2, 3]));
  const runtime = { levels: [lodScene, coarse].map((scene, index) => ({ scene, tolerance: index,
    segmentCount: scene.segmentCount, visibleSegmentIds: Uint32Array.from([0, 1, 2, 3]), visibleSegmentCount: index ? 0 : 4 })) };
  const lodPlan = new VectorOrderedBatches(lodScene, runtime);
  lodPlan.update(lodScene.drawRuns);
  const lodOrder = paints(lodPlan);
  lodPlan.update(lodScene.drawRuns, 0.1);
  assertOverlapOrder(lodPlan, lodOrder, lodScene,
    new VectorDrawRunCuller(lodScene, { scene: coarse, sourceRuns: Uint32Array.from([0, 2, 5, 7]) }));
  coarse.primitiveMeta[3] = 9; // Alpha 1 and rectangular clip flag.
  const boundedLodPlan = new VectorOrderedBatches(lodScene, runtime);
  boundedLodPlan.update(lodScene.drawRuns, 0.1);
  assert.equal(boundedLodPlan.batches.length, 6, "fragment clip rectangles bound simplified strokes too");

  // Culling and changing the selected LOD subset must not retain old IDs.
  const visible = scene.drawRuns.slice(5, 10);
  plan.update(visible, 0.1);
  assert.deepEqual(paints(plan), original.filter(paint => pageOf(paint) === 1));
  assert.equal(plan.update(visible, 0.1), false);
  runtime.levels[0].visibleSegmentCount = 0;
  runtime.levels[1].visibleSegmentCount = 4;
  boundedLodPlan.invalidate();
  assert(boundedLodPlan.update(lodScene.drawRuns, 0.1));
  const strokeIds = paints(boundedLodPlan).filter(p => p.startsWith("stroke:")).map(p => Number(p.split(":")[1]));
  assert.deepEqual(strokeIds.slice().sort((a, b) => a - b), [4, 5, 6, 7]);

  // Exercise both production dispatchers, including disabling scheduling for
  // GL's arbitrary local-to-clip projection. These checks need no GPU/server.
  for (const Renderer of [WebGlFloorplanRenderer, WebGpuFloorplanRenderer]) {
    const renderer = Object.assign(Object.create(Renderer.prototype), {
      scene, orderedBatches: new VectorOrderedBatches(scene, null), zoom: 10,
      vectorLodLevels: [], vectorLodLevelResources: [], rasterRenderingEnabled: false,
      gl: { bindBuffer() {}, bufferData() {} }, gpuDevice: { queue: { writeBuffer() {} } }
    });
    renderer.drawPageBackgroundContentIntoPass = () => {};
    const draw = Renderer === WebGlFloorplanRenderer
      ? () => renderer.drawSourceOrderedContent(100, 100, 50, 50, 10)
      : () => renderer.drawSourceOrderedContentIntoPass({});
    draw();
    assert.equal(renderer.orderedBatches.batches.length, 7);
    if (Renderer === WebGlFloorplanRenderer) {
      renderer.localToClipRenderingEnabled = true;
      draw();
      assert.deepEqual(paints(renderer.orderedBatches), original);
    }
  }

  // Varied, deterministic paint streams exercise overlap dependencies that
  // do not follow page or primitive-ID order, including translucent paints.
  let seed = 711;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 40; trial++) {
    const varied = makePages(Array.from({ length: 12 }, () => Math.floor(random() * 6) * 20));
    varied.pageRects = Float32Array.from([0, 0, 120, 10]);
    for (let i = varied.drawRuns.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [varied.drawRuns[i], varied.drawRuns[j]] = [varied.drawRuns[j], varied.drawRuns[i]];
    }
    assertOverlappingPaints(varied);
  }
  console.log("Independent-page batching, overlap order, vector clips, and LOD bounds passed");

  function makePages(xs) {
    const scene = createEmptyVectorScene();
    scene.pageRects = Float32Array.from(xs.flatMap(x => [x, 0, x + 10, 10]));
    scene.segmentCount = xs.length * 2;
    scene.fillPathCount = scene.textInstanceCount = xs.length;
    scene.textGlyphCount = 1;
    scene.textGlyphMetaA = Float32Array.from([0, 0, 0, 0]);
    scene.textGlyphMetaB = Float32Array.from([1, 1, 0, 0]);
    scene.drawRuns = [];
    for (const key of ["endpoints", "primitiveMeta", "primitiveBounds", "styles"]) scene[key] = new Float32Array(scene.segmentCount * 4);
    for (const key of ["fillPathMetaA", "fillPathMetaB", "textInstanceA", "textInstanceB"]) scene[key] = new Float32Array(xs.length * 4);
    xs.forEach((x, page) => {
      for (const id of [page * 2, page * 2 + 1]) {
        scene.endpoints.set([x + 1, 1, x + 9, 9], id * 4);
        scene.primitiveMeta.set([x + 9, 9, 0, 0.5], id * 4);
        scene.primitiveBounds.set([x, 0, x + 10, 10], id * 4);
        scene.styles[id * 4] = 0.25;
      }
      scene.fillPathMetaA.set([0, 0, x, 0], page * 4);
      scene.fillPathMetaB.set([x + 10, 10, 0, 0.5], page * 4);
      scene.textInstanceA.set([1, 0, 0, 1], page * 4);
      scene.textInstanceB.set([x, 0, 0, 0.5], page * 4);
      scene.rasterLayers.push({ matrix: Float32Array.from([10, 0, 0, 10, x, 0]) });
      scene.drawRuns.push({ kind: "stroke", first: page * 2, count: 1 },
        { kind: "fill", first: page, count: 1 }, { kind: "stroke", first: page * 2 + 1, count: 1 },
        { kind: "text", first: page, count: 1 }, { kind: "raster", first: page, count: 1 });
    });
    return scene;
  }
  function paints(plan) {
    return plan.batches.flatMap(run => Array.from({ length: run.count }, (_, i) => {
      const instance = (run.first + i) * 2;
      return `${run.kind}:${run.clipIndex === -2 ? plan.uintInstances[instance] : run.first + i}:${run.clipIndex === -2 ? plan.uintInstances[instance + 1] : (run.clipIndex ?? -1) + 1}`;
    }));
  }
  function pageOf(paint) {
    const [kind, id] = paint.split(":");
    return kind === "stroke" ? Math.floor(Number(id) / 2) : Number(id);
  }
  function assertPageOrder(plan, source, pages) {
    const matches = paint => pages.includes(pageOf(paint));
    assert.deepEqual(paints(plan).filter(matches), source.filter(matches), "overlapping paints keep source order, including transparency and images");
  }
  function assertOverlappingPaints(scene) {
    const plan = new VectorOrderedBatches(scene, null);
    plan.update(scene.drawRuns);
    const original = paints(plan);
    plan.update(scene.drawRuns, 0.1);
    assertOverlapOrder(plan, original, scene);
  }
  function assertOverlapOrder(plan, original, scene, culler = new VectorDrawRunCuller(scene)) {
    const actual = paints(plan);
    assert.deepEqual(actual.slice().sort(), original.slice().sort(), "every paint appears exactly once");
    const boxes = scene.drawRuns.map((_, index) => {
      const box = [];
      culler.getBounds(index, 0.5, box);
      return box;
    });
    // Exhaustively check every dependency, independently of the bounded
    // scheduling search. These fixtures have one primitive per source run.
    for (let first = 0; first < original.length; first++) {
      for (let second = first + 1; second < original.length; second++) {
        const a = boxes[first], b = boxes[second];
        if (a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]) continue;
        assert(actual.indexOf(original[first]) < actual.indexOf(original[second]),
          `overlapping paints must keep source order: ${original[first]}, ${original[second]}`);
      }
    }
  }
  function rectangle(x0, y0, x1, y1, parent = -1) {
    return { parent, fillRule: 0, edges: Float32Array.from([x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0]) };
  }
} finally { hooks.deregister(); }
