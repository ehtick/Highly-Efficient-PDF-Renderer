import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) &&
      !/\.[a-z0-9]+(?:[?#]|$)/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { sampleSceneGradientChannel: sample } = await import("../src/gradientSampling.ts");
  const { ScenePrimitivePicker } = await import("../src/scenePrimitives.ts");
  const scene = createEmptyVectorScene();
  Object.assign(scene, {
    gradientCount: 1,
    gradientMetaA: Float32Array.of(0, 0, 0, 0),
    gradientMetaB: Float32Array.of(1, 0, 0, 1),
    gradientMetaC: Float32Array.of(0, 0, 0, 0),
    gradientMetaD: Float32Array.of(1, 0, 0, 0),
    gradientMetaE: Float32Array.of(-2, -2, 3, 3),
    gradientLut: new Uint8Array(1024 * 4),
    gradientFillPathCount: 1, gradientFillSegmentCount: 4,
    gradientFillPathMetaA: Float32Array.of(0, 4, -2, -2),
    gradientFillPathMetaB: Float32Array.of(3, 3, 0, 0),
    gradientFillPathMetaC: Float32Array.of(0, 0, 0, 1),
    gradientFillPaintMeta: Float32Array.of(0, -1, 0, 0),
    gradientFillSegmentsA: Float32Array.of(-2,-2,3,-2, 3,-2,3,3, 3,3,-2,3, -2,3,-2,-2),
    gradientFillSegmentsB: Float32Array.of(3,-2,0,0, 3,3,0,0, -2,3,0,0, -2,-2,0,0)
  });
  for (let i = 0; i < 1024; i++) scene.gradientLut.set([Math.round(i / 1023 * 255), 0, 0, 255], i * 4);
  const close = (actual, expected) => assert(Math.abs(actual - expected) < .002, `${actual} ≈ ${expected}`);
  assert.equal(sample(scene, 0, -1, 0, 3), 1, "legacy metadata extends both ends");
  assert.equal(sample(scene, 0, 2, 0, 3), 1);
  scene.gradientMetaA[2] = 3;
  assert.equal(sample(scene, 0, -1, 0, 3), 0, "disabled start is transparent");
  assert.equal(sample(scene, 0, 2, 0, 3), 0, "disabled end is transparent");
  close(sample(scene, 0, .25, 0, 0), .25);
  const picker = new ScenePrimitivePicker(scene);
  const pick = point => picker.pick({ point, clientPoint: point, project: p => p, unproject: p => p, tolerancePx: 0 });
  assert.equal(await pick({ x: -1, y: 0 }), null, "picking respects the restricted gradient domain");
  assert.equal((await pick({ x: .25, y: 0 }))?.primitive.kind, "gradient-fill");
  picker.dispose();

  scene.gradientMetaA[3] = 0x0033cc + 1;
  assert.equal(sample(scene, 0, -1, 0, 3), 1);
  close(sample(scene, 0, -1, 0, 1), .2);
  close(sample(scene, 0, -1, 0, 2), .8);
  scene.gradientMetaA[1] = 1;
  assert.equal(sample(scene, 0, -3, 0, 3), 0, "BBox clips the background too");
  scene.gradientMetaA[3] = 0xffffff + 1;
  assert.equal(sample(scene, 0, -1, 0, 0), 1, "largest packed background survives float32");

  scene.gradientMetaA.set([1, 0, 3, 0]);
  scene.gradientMetaD.set([2, 0, 1, 1]);
  close(sample(scene, 0, .5, 0, 0), .75, "intersecting circles use the highest eligible root");
  close(sample(scene, 0, 1.5, 0, 0), .25, "an out-of-domain high root must not hide a valid low root");
  assert.equal(sample(scene, 0, 1, 2, 3), 0, "points outside the radial cone stay transparent");
  scene.gradientMetaD.set([1, 0, 0, 1]);
  close(sample(scene, 0, .5, 0, 0), .25, "tangent circle families use the linear root");
  scene.gradientMetaD.set([0, 0, 1, 0]);
  close(sample(scene, 0, .25, 0, 0), .75, "shrinking circles exclude negative-radius roots");
  scene.gradientMetaB.set([.5, 0, -.25, 1]);
  close(sample(scene, 0, .5, 0, 0), .75, "sampling uses the inverse shading transform");
  console.log("gradient sampling: extensions, backgrounds, radial roots, transforms and picking passed");
} finally { hooks.deregister(); }
