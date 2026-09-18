import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !specifier.endsWith(".ts") ? `${specifier}.ts` : specifier, context);
} });
try {
  const { openPdf } = await import("../src/pdfSession.ts");
  const { OptionalContentController } = await import("../src/optionalContent.ts");
  const { ScenePrimitivePicker, getScenePrimitive, isScenePrimitiveVisible } = await import("../src/scenePrimitives.ts");
  const { validateScenePaintGraph } = await import("../src/scenePaintGraph.ts");
  const bytes = writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [13 0 R 14 0 R] /D << /BaseState /OFF >> >> >>" },
    { number: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Properties << /A 13 0 R >> /Pattern << /P 5 0 R >> /Font << /F 6 0 R >> /ExtGState << /ImageAlpha << /ca .3 >> /Mask << /SMask << /S /Alpha /G 10 0 R >> >> >> /XObject << /Im 8 0 R /Fm 9 0 R >> >> /Contents 4 0 R /Annots [11 0 R] >>" },
    { number: 4, body: tinyPdfStream("", "/OC /A BDC /Pattern cs /P scn 0 0 20 20 re f /DeviceRGB cs 0 0 0 sc BT /F 20 Tf 1 0 0 1 30 0 Tm (A) Tj ET q /ImageAlpha gs 10 0 0 10 60 0 cm /Im Do Q /Fm Do q /Mask gs 1 0 1 rg 0 40 20 20 re f Q EMC 1 0 0 rg 90 90 5 5 re f") },
    { number: 5, body: tinyPdfStream("/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 5 5] /XStep 10 /YStep 10 /Resources << /Properties << /B 14 0 R >> >>", "/OC /B BDC 0 0 1 rg 0 0 5 5 re f EMC") },
    { number: 6, body: "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 500 500] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [500] /Resources << /Properties << /B 14 0 R >> >> >>" },
    { number: 7, body: tinyPdfStream("", "500 0 d0 /OC /B BDC 0 1 0 rg 0 0 500 500 re f EMC") },
    { number: 8, body: tinyPdfStream("/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8", Uint8Array.of(255,255,255)) },
    { number: 9, body: tinyPdfStream("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /OC 14 0 R /Resources << >>", "0 30 m 20 30 l S") },
    { number: 10, body: tinyPdfStream("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /OC 14 0 R /Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources << >>", "1 1 1 rg 0 40 10 20 re f") },
    { number: 11, body: "<< /Type /Annot /Subtype /Stamp /Rect [30 30 40 40] /OC 14 0 R /AP << /N 12 0 R >> >>" },
    { number: 12, body: tinyPdfStream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /OC 13 0 R /Resources << >>", "1 1 0 rg 0 0 10 10 re f") },
    { number: 13, body: "<< /Type /OCG /Name (A) >>" },
    { number: 14, body: "<< /Type /OCG /Name (B) >>" }
  ] });
  const session = await openPdf({kind:"bytes",bytes});
  try {
    const scene=await session.compileVectorPage(0,{vectorFallback:"error"});
    await session.compilePage(0);
    validateScenePaintGraph(scene);
    assert.equal(scene.rasterLayers.length,1,"only the original image remains raster");
    const original=structuredClone(scene), layers=new OptionalContentController(scene), picker=new ScenePrimitivePicker(scene);
    const id = name => scene.optionalContent.groups.find(group=>group.name===name).id;
    const visible = condition => layers.isVisible(condition);
    const pick = (x,y) => picker.pick({point:{x,y},clientPoint:{x,y},project:p=>p,unproject:p=>p,tolerancePx:0,isConditionVisible:visible});
    assert.equal(await pick(2,2),null,"default-off pattern paint is retained but hidden");
    await layers.setLayerVisibility(id("A"),true);
    assert.equal(await pick(2,2),null,"nested pattern OCG remains independent");
    assert.equal(await pick(5,50),null,"default-off soft-mask Form makes owner transparent");
    const image=await pick(65,5);; assert.equal(image.primitive.kind,"raster");
    const ancestors=[];
    const visit=nodes=>{for(const node of nodes)if(node.kind==="group"){ancestors.push(node);visit(node.children);}};
    visit(scene.paintGraph.roots);
    assert(ancestors.some(group=>Math.abs(group.alpha-.3)<1e-6),"image opacity remains on its compositing scope");
    await layers.setLayerVisibility(id("B"),true);
    for(const [x,y,color] of [[2,2,[0,0,1]],[35,5,[0,1,0]],[35,35,[1,1,0]]]) {
      const hit=await pick(x,y); assert.ok(hit,`retained paint at ${x},${y} becomes visible`);
      const info=getScenePrimitive(scene,hit.primitive); assert.deepEqual(info.color,color);
      assert.deepEqual(new Set(info.optionalContent.layerIds),new Set([id("A"),id("B")]));
    }
    assert.equal((await pick(5,50)).primitive.kind,"fill");
    assert.equal(await pick(15,50),null,"soft-mask geometry clips the owner's appearance");
    const stroke=await pick(10,30); assert.equal(stroke.primitive.kind,"stroke");
    await layers.setLayerVisibility(id("A"),false);
    assert.equal(isScenePrimitiveVisible(scene,stroke.primitive,visible),false);
    assert.deepEqual(scene,original,"layer toggles and geometric queries preserve canonical arrays");
    picker.dispose();layers.dispose();
  } finally {await session.close();}
  console.log("Retained layered programs passed: patterns, Type3, images, Forms, annotations, masks and immutable queries.");
} finally {hooks.deregister();}
