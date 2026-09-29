import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as THREE from "three";
const hooks = registerHooks({ resolve(s,c,next) {
  return next(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? s + ".ts" : s,c);
} });
try {
  const { analyzePlanarBoundsProjection,createOrthographicLocalToClip } = await import("../src/planarProjection.ts");
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { buildTextLod,buildTextLodAsync } = await import("../src/textGreekLod.ts");
  const { TextLodRuntime } = await import("../src/textLodCore.ts");
  const { OrderedTextLodSelection } = await import("../src/orderedTextLod.ts");
  const viewport = { width: 1920,height: 945 }, box = { minX: -20,minY: 0,maxX: 200,maxY: 600 };
  let seed = 731;
  const random = () => ((seed = (Math.imul(seed,1664525) + 1013904223) >>> 0) / 2 ** 32);
  // Compare analytical bounds with independent pointwise Jacobians, including
  // rotated/reflected baselines and sheared glyph-height axes.
  for (let sample = 0; sample < 60; sample++) {
    const m = Float64Array.of(.04 * (random() - .5),.04 * (random() - .5),0,.0001 * random(),
      .04 * (random() - .5),.04 * (random() - .5),0,.002 * random(),0,0,1,0,random() - .5,random() - .5,0,.5 + random());
    const angle = random() * Math.PI * 2, tilt = angle + .2 + random() * 2;
    const baseline = [Math.cos(angle),Math.sin(angle)], direction = [Math.cos(tilt),Math.sin(tilt)];
    for (const u of [undefined,baseline]) {
      const projection = analyzePlanarBoundsProjection(box,m,viewport,direction,u);
      assert(projection.stable);
      for (let row = 0; row <= 8; row++) for (let col = 0; col <= 8; col++) {
        const x = box.minX + (box.maxX - box.minX) * col / 8, y = box.minY + (box.maxY - box.minY) * row / 8;
        const X = m[0] * x + m[4] * y + m[12], Y = m[1] * x + m[5] * y + m[13], W = m[3] * x + m[7] * y + m[15];
        const a = (m[0] * W - X * m[3]) / W ** 2 * viewport.width / 2;
        const b = (m[1] * W - Y * m[3]) / W ** 2 * viewport.height / 2;
        const c = (m[4] * W - X * m[7]) / W ** 2 * viewport.width / 2;
        const d = (m[5] * W - Y * m[7]) / W ** 2 * viewport.height / 2;
        const vx = a * direction[0] + c * direction[1], vy = b * direction[0] + d * direction[1];
        const ux = u ? a * u[0] + c * u[1] : 0, uy = u ? b * u[0] + d * u[1] : 0;
        const scale = u ? Math.abs(ux * vy - uy * vx) / Math.hypot(ux,uy) : Math.hypot(vx,vy);
        assert(scale <= projection.maxPixelsPerLocalUnit + 1e-8,"upper bound must preserve readable text everywhere in the cluster");
        assert(scale >= projection.minPixelsPerLocalUnit - 1e-8,"lower bound must not force a compressed cluster exact");
      }
    }
  }
  const shear = Float64Array.of(.02,0,0,0, .2,.0004,0,0, 0,0,1,0, 0,0,0,1);
  const squareViewport = { width: 1000,height: 1000 };
  const compressed = analyzePlanarBoundsProjection(box,shear,squareViewport,[0,1],[1,0]);
  assert.equal(compressed.maxPixelsPerLocalUnit,.2,"sideways shear must not inflate perpendicular text height");
  assert.equal(compressed.minPixelsPerLocalUnit,.2);
  assert(analyzePlanarBoundsProjection(box,shear,squareViewport,[0,1]).maxPixelsPerLocalUnit > 100);
  const crossing = shear.slice(); crossing[7] = 1; crossing[15] = -100;
  assert.equal(analyzePlanarBoundsProjection(box,crossing,viewport,[0,1],[1,0]).stable,false,"camera-plane crossings stay exact");
  const behind = shear.slice(); behind[15] = -1;
  assert.equal(analyzePlanarBoundsProjection(box,behind,viewport,[0,1],[1,0]).visible,false);
  const invalid = shear.slice(); invalid[0] = NaN;
  assert.equal(analyzePlanarBoundsProjection(box,invalid,viewport,[0,1],[1,0]).stable,false);

  const count = 60_000, perPage = count / 2;
  const scene = { ...createEmptyVectorScene(),textInstanceCount: count,textGlyphCount: 1,textGlyphSegmentCount: 4,
    textInstanceA: new Float32Array(count * 4),textInstanceB: new Float32Array(count * 4),textInstanceC: new Float32Array(count * 4),
    textGlyphMetaA: Float32Array.of(0,4,0,0),textGlyphMetaB: Float32Array.of(7,10,0,0),
    textGlyphSegmentsA: Float32Array.of(0,0,0,0, 7,0,7,0, 7,10,7,10, 0,10,0,10),
    textGlyphSegmentsB: Float32Array.of(7,0,0,0, 7,10,0,0, 0,10,0,0, 0,0,0,0),
    pageCount: 2,pageRects: Float32Array.of(0,0,5000,720, 0,3000,5000,3720),pageTextRanges: Uint32Array.of(0,perPage,perPage,perPage),
    bounds: { minX: 0,minY: 0,maxX: 5000,maxY: 3720 },
    drawRuns: Array.from({ length: 10 },(_,i) => ({ kind: "text",first: i * 6000,count: 6000 })) };
  scene.pageBounds = scene.bounds;
  for (let i = 0; i < count; i++) {
    scene.textInstanceA.set([1,0,0,1],i * 4);
    scene.textInstanceB.set([i % 500 * 10,Math.floor((i % perPage) / 500) * 12 + (i >= perPage ? 3000 : 0),0,0],i * 4);
    scene.textInstanceC.set([0,0,0,1],i * 4);
  }
  const canonical = structuredClone(scene), result = buildTextLod(scene), data = result.data;
  assert(data);
  for (const node of [...data.clusters,...data.pages]) {
    assert.deepEqual(node.inkHeightDirection,[0,1]); assert.deepEqual(node.baselineDirection,[1,0]);
  }
  const asyncResult = await buildTextLodAsync(scene);
  assert(asyncResult.data.clusters.every(c => c.inkHeightDirection[0] === 0 && c.baselineDirection[1] === 0));
  const camera = new THREE.PerspectiveCamera(45,viewport.width / viewport.height,.01,100_000);
  camera.position.set(2500,-200,20); camera.lookAt(2500,0,0); camera.updateMatrixWorld(true);
  const input = { localToClip: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).elements,
    viewportWidth: viewport.width,viewportHeight: viewport.height };
  const runtime = new TextLodRuntime(result), selection = runtime.update(input);
  const legacy = { ...data,clusters: data.clusters.map(c => ({ ...c,inkHeightDirection: undefined,baselineDirection: undefined })),
    pages: data.pages.map(p => ({ ...p,inkHeightDirection: undefined,baselineDirection: undefined })) };
  const previous = new TextLodRuntime({ ...result,data: legacy }).update(input);
  assert(selection.instanceIds.length < previous.instanceIds.length / 2,`grazing views simplify far text: ${previous.instanceIds.length}→${selection.instanceIds.length}`);
  assert(selection.instanceIds.some(id => id < perPage),"nearby readable text stays exact");
  assert(!selection.instanceIds.some(id => id >= perPage && id < count),"the distant page uses only coarse runs");
  assert.equal(runtime.update(input).changed,false,"stationary tilted views reuse their selection");
  runtime.setMode("off"); const off = runtime.update(input);
  assert.equal(off.stats.renderedRuns,0); assert(off.instanceIds.some(id => id >= perPage && id < count));

  // Rotating the projected axes can change text height while preserving the
  // maximum singular value and cropped viewport: cache the complete basis.
  const affine = createOrthographicLocalToClip(0,0,1,1920,945);
  affine[0] = 2 * .8 / 1920; affine[5] = 2 * .04 / 945;
  const cropped = { localToClip: affine,viewportWidth: 1920,viewportHeight: 945,cullingBounds: { minX: 0,minY: 0,maxX: 100,maxY: 100 } };
  const cache = new TextLodRuntime(result);
  assert(cache.update(cropped).stats.coarseClusters > 0);
  cache.update(cropped);
  const rotated = affine.slice(); rotated[0] = rotated[5] = 0; rotated[1] = 2 * .04 / 945; rotated[4] = 2 * .8 / 1920;
  assert.equal(cache.update({ ...cropped,localToClip: rotated }).stats.coarseClusters,0,"orientation changes invalidate affine selection reuse");

  // Routing should search once per paint boundary, not once per exact glyph.
  const ordered = new OrderedTextLodSelection(scene,data);
  let lookups = 0; const lookup = ordered.paintAt.bind(ordered);
  ordered.paintAt = id => { lookups++; return lookup(id); };
  const exact = Uint32Array.from({ length: count },(_,i) => i);
  ordered.update({ instanceIds: exact,changed: true,stats: off.stats });
  assert(lookups <= scene.drawRuns.length,`${lookups} paint lookups for ${count} glyphs`);
  assert.deepEqual(ordered.instanceIds,exact);
  ordered.update({ instanceIds: exact.slice().reverse(),changed: true,stats: off.stats });
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(ordered.instanceIds.slice(i * 6000,(i + 1) * 6000),exact.slice(i * 6000,(i + 1) * 6000).reverse(),
      "paint caching also preserves arbitrary selection order within each paint");
  }
  assert.deepEqual(scene,canonical);
  console.log(`Foreshortened text: ${previous.instanceIds.length}→${selection.instanceIds.length} instances; conservative height bounds, near/far detail, camera safety, affine cache and paint lookup budget passed.`);
} finally { hooks.deregister(); }
