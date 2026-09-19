import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as THREE from "three";

const hooks = registerHooks({ resolve(s, c, n) {
  return n(c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? `${s}.ts` : s, c);
} });

try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { applyThreePdfOverlayPaintOrder } = await import("../src/threePdfPaintOrder.ts");
  const { vectorDrawRunRenderOrder } = await import("../src/threeVectorDrawRuns.ts");
  const { HEPR_THREE_LAYER_ORDER_PAGE_BACKGROUND, HEPR_THREE_LAYER_ORDER_RASTER, HEPR_THREE_LAYER_ORDER_FILL } =
    await import("../src/threeLayerOrder.ts");

  const scene = Object.assign(createEmptyVectorScene(), {
    pageRects: Float32Array.of(0, 0, 10, 10, 20, 0, 30, 10, 40, 0, 50, 10),
    gradientFillPathCount: 1,
    drawRuns: [
      { kind: "fill", first: 0, count: 1000000 },
      { kind: "raster", first: 0, count: 4 },
      { kind: "gradient-fill", first: 0, count: 1 },
      { kind: "stroke", first: 0, count: 1000000 },
      { kind: "raster", first: 4, count: 4 },
      { kind: "gradient-stroke", first: 0, count: 1 },
      { kind: "text", first: 0, count: 1000000 }
    ]
  });
  const group = new THREE.Group();
  const background = new THREE.Object3D();
  background.userData.heprPageBackground = true;
  background.renderOrder = HEPR_THREE_LAYER_ORDER_PAGE_BACKGROUND;
  const originals = Array.from({ length: 8 }, (_, first) => raster(first, 1));
  const firstBatch = raster(0, 4), secondBatch = raster(4, 4), crossingBatch = raster(3, 2);
  crossingBatch.renderOrder = 123;
  const completion = new THREE.Object3D();
  completion.userData.heprMultiplyCompletion = true;
  originals[1].add(completion);
  // Child placement and visibility are deliberately unrelated to source IDs.
  originals[0].visible = false;
  group.add(background, originals[4], originals[0], originals[7], firstBatch, originals[5], originals[3],
    originals[2], originals[1], originals[6], secondBatch, crossingBatch);
  const gradientFill = new THREE.Object3D(), gradientStroke = new THREE.Object3D();
  const gradients = [gradientFill, gradientStroke].map(mesh => ({ mesh, pageIndex: 0, paintOrder: 0 }));
  applyThreePdfOverlayPaintOrder(scene, group, gradients);
  const order = index => vectorDrawRunRenderOrder(index, scene.drawRuns.length);
  originals.forEach((mesh, index) => assert.equal(mesh.renderOrder, order(index < 4 ? 1 + index / 4 : 4 + (index - 4) / 4)));
  assert.equal(firstBatch.renderOrder, originals[0].renderOrder);
  assert.equal(secondBatch.renderOrder, originals[4].renderOrder);
  assert.equal(completion.renderOrder, order(1 + 1.5 / 4), "multiply completion keeps its per-image half step");
  assert.equal(gradientFill.renderOrder, order(2));
  assert.equal(gradientStroke.renderOrder, order(5));
  assert(originals[3].renderOrder < gradientFill.renderOrder && gradientFill.renderOrder < secondBatch.renderOrder);
  assert(originals[7].renderOrder < gradientStroke.renderOrder);
  assert.equal(background.renderOrder, HEPR_THREE_LAYER_ORDER_PAGE_BACKGROUND, "one merged background serves all three pages");
  assert.equal(crossingBatch.renderOrder, 123, "a batch spanning an intervening canonical run is not assigned a misleading order");

  const legacy = Object.assign(createEmptyVectorScene(), {
    pageRects: Float32Array.of(0, 0, 10, 10, 20, 0, 30, 10),
    rasterLayers: [layer(0, 5), { ...layer(0, 0), width: 0 }, layer(1, 2), layer(0, 1)]
  });
  const legacyGroup = new THREE.Group();
  const legacyBackground = new THREE.Object3D();
  legacyBackground.userData.heprPageBackground = true;
  legacyBackground.renderOrder = HEPR_THREE_LAYER_ORDER_PAGE_BACKGROUND;
  const a = raster(0, 1), b = raster(1, 1), c = raster(2, 1), alias = raster(0, 1);
  legacyGroup.add(legacyBackground, c, b, a, alias);
  const firstGradient = new THREE.Object3D(), lastGradient = new THREE.Object3D();
  applyThreePdfOverlayPaintOrder(legacy, legacyGroup, [
    { mesh: firstGradient, pageIndex: 0, paintOrder: 3 },
    { mesh: lastGradient, pageIndex: 1, paintOrder: 1 }
  ]);
  const span = HEPR_THREE_LAYER_ORDER_FILL - HEPR_THREE_LAYER_ORDER_RASTER;
  [c, firstGradient, a, lastGradient, b].forEach((mesh, index) =>
    assert.equal(mesh.renderOrder, HEPR_THREE_LAYER_ORDER_RASTER + span * (index + 1) / 6));
  assert.equal(alias.renderOrder, a.renderOrder, "aliases share one canonical paint rank in legacy scenes");
  assert.equal(legacyBackground.renderOrder, HEPR_THREE_LAYER_ORDER_PAGE_BACKGROUND);

  // Older adapter-created dummy groups lack source metadata. Keep their
  // existing positional behavior while preferring marked merged backgrounds.
  const positionalScene = { ...scene, pageRects: Float32Array.of(0, 0, 10, 10), drawRuns: [{ kind: "raster", first: 0, count: 1 }] };
  const positional = new THREE.Group(), positionalImage = new THREE.Object3D();
  positional.add(new THREE.Object3D(), positionalImage);
  applyThreePdfOverlayPaintOrder(positionalScene, positional, []);
  assert.equal(positionalImage.renderOrder, vectorDrawRunRenderOrder(0, 1));
  const marked = new THREE.Group(), markedImage = new THREE.Object3D(), markedBackground = new THREE.Object3D();
  markedBackground.userData.heprPageBackground = true;
  marked.add(markedBackground, markedImage);
  applyThreePdfOverlayPaintOrder({ ...positionalScene, pageRects: scene.pageRects }, marked, []);
  assert.equal(markedImage.renderOrder, vectorDrawRunRenderOrder(0, 1));

  console.log("Three raster paint order: canonical batch ranges, merged backgrounds, gradients, multiply completion and legacy aliases passed.");
} finally { hooks.deregister(); }

function raster(first, count) {
  const mesh = new THREE.Object3D();
  mesh.userData.heprDrawRun = { kind: "raster", first, count };
  return mesh;
}

function layer(pageIndex, paintOrder) {
  return { width: 1, height: 1, data: Uint8Array.of(255, 0, 0, 255), matrix: Float32Array.of(1, 0, 0, 1, 0, 0), pageIndex, paintOrder };
}
