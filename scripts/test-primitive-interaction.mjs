import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes("/src/") && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const originalRaf = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
const frames = new Map(); let nextFrame = 1;
globalThis.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
function frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(performance.now()); }
async function settle() {
  for (let i = 0; i < 12; i++) { frame(); await new Promise(resolve => setTimeout(resolve, 0)); }
}
class Canvas extends EventTarget {
  width = 100; height = 100; ownerDocument = new EventTarget();
  classList = {
    tokens: new Set(),
    toggle(token, force) { if (force) this.tokens.add(token); else this.tokens.delete(token); return force; },
    remove(token) { this.tokens.delete(token); }
  };
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
}
function pointer(canvas, type, x, y, extras = {}) {
  const event = new Event(type);
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerdown" ? 1 : 0, ...extras });
  canvas.dispatchEvent(event);
}
try {
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const { createPrimitiveInteractionController } = await import("../src/primitiveInteraction.ts");
  let scene = createEmptyVectorScene();
  Object.assign(scene, { segmentCount: 1, pageCount: 1, pageRects: Float32Array.of(0,0,100,100),
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    endpoints: Float32Array.of(0,10,100,10), primitiveMeta: Float32Array.of(100,10,0,1),
    primitiveBounds: Float32Array.of(0,10,100,10), styles: Float32Array.of(1,0,0,0) });
  let canvas = new Canvas();
  const views = { cameraCenterX: 50, cameraCenterY: 50, zoom: 1 };
  const presentedViews = { ...views };
  let highlights = null, colorUpdates = [], selected = null, selectedColor = null, errors = [];
  const preparation = [];
  const rendererFactory = () => ({
    getPresentedViewState: () => ({ ...presentedViews }),
    getViewState: () => ({ ...views }),
    clientToScenePoint: (x,y) => ({ x,y: y - (views.cameraCenterY - 50) }),
    sceneToClientPoint: (x,y) => ({ x,y: y + (views.cameraCenterY - 50) }),
    setPrimitiveHighlights: value => { highlights = value; },
    setPrimitiveColorUpdates: value => { colorUpdates.push(value); }
  });
  let renderer = rendererFactory();
  const controller = createPrimitiveInteractionController({ getScene: () => scene, getCanvas: () => canvas,
    getRenderer: () => renderer, onSelectionChange: (value, color) => { selected = value; selectedColor = color; },
    onPreparationProgress: percentage => preparation.push(percentage), onError: error => errors.push(error) });
  pointer(canvas,"pointermove",20,10);
  await settle();
  assert.equal(highlights, null, "disabled by default");
  assert.equal(controller.isEnabled(), false);
  assert.deepEqual(preparation, [], "disabled mode does not start preparing");
  controller.enable();
  // Releasing the pan gesture schedules a renderer frame ahead of the pick's RAF.
  // That first frame after enabling selection must not consume the first click.
  pointer(canvas,"pointerdown",20,10); pointer(canvas,"pointerup",20,10);
  controller.onFrame();
  await settle();
  assert.equal(selected?.kind, "stroke", "first click selects before any prior renderer frame");
  assert.equal(preparation[0], 0);
  assert.equal(preparation.at(-1), 100, "first pick finishes preparation");
  const initialProgressCount = preparation.length;
  const escape = new Event("keydown"); Object.assign(escape,{key:"Escape"}); canvas.ownerDocument.dispatchEvent(escape);
  pointer(canvas,"pointermove",20,10);
  await settle();
  assert.equal(highlights.count, 1); assert.equal(highlights.selectionCount, 0);
  assert.equal(preparation.length, initialProgressCount, "warm hover does not restart the indicator");
  pointer(canvas,"pointerdown",20,10); pointer(canvas,"pointerup",20,10);
  await settle();
  assert.equal(selected.kind, "stroke"); assert.equal(selected.index, 0);
  assert.equal(highlights.selectionCount, 1);
  controller.setSelectedColor("red");
  assert.deepEqual(colorUpdates.at(-1)[0].color, [1,0,0]);
  assert.deepEqual(selectedColor,[1,0,0]);
  controller.resetSelectedColor();
  assert.deepEqual(selectedColor,[0,0,0], "reset updates the color control to the original style");
  controller.setSelectedColor("red");

  const oldCanvas = canvas;
  canvas = new Canvas(); renderer = rendererFactory();
  controller.rendererChanged(); controller.onFrame();
  assert.deepEqual(colorUpdates.at(-1)[0].color, [1,0,0], "replay overrides after backend switch");
  assert.equal(highlights.selectionCount, 1);
  pointer(oldCanvas,"pointerdown",80,80); pointer(oldCanvas,"pointerup",80,80);
  await settle();
  assert(selected, "old canvas listeners detached");
  assert.equal(preparation.length, initialProgressCount, "backend switch reuses prepared picking");
  pointer(canvas,"pointerdown",20,10); pointer(canvas,"pointermove",70,80,{buttons:1}); pointer(canvas,"pointerup",70,80);
  await settle();
  assert(selected, "dragging must not clear selection");
  pointer(canvas,"pointerdown",10,80,{pointerType:"touch",pointerId:1});
  pointer(canvas,"pointerdown",20,80,{pointerType:"touch",pointerId:2});
  pointer(canvas,"pointerup",20,80,{pointerType:"touch",pointerId:2});
  pointer(canvas,"pointerup",10,80,{pointerType:"touch",pointerId:1});
  await settle(); assert(selected, "pinch must not select");

  canvas.ownerDocument.dispatchEvent(escape);
  assert.equal(selected,null);
  pointer(canvas,"pointerdown",80,80,{pointerType:"touch",pointerId:9});
  pointer(canvas,"lostpointercapture",80,80,{pointerType:"touch",pointerId:9});
  pointer(canvas,"pointermove",20,10);
  await settle(); assert.equal(highlights.count,1, "lost capture releases a cancelled gesture");
  pointer(canvas,"pointerdown",20,10,{pointerType:"touch"}); pointer(canvas,"pointerup",20,10,{pointerType:"touch"});
  pointer(canvas,"lostpointercapture",20,10,{pointerType:"touch"});
  pointer(canvas,"pointerleave",20,10,{pointerType:"touch"});
  await settle(); assert(selected, "tap selects");
  assert.equal(highlights.count, 1, "completed touch tap selects without retaining hover after pointerleave");
  assert.deepEqual(selectedColor,[1,0,0], "reselection shows the current override");
  pointer(canvas,"pointerdown",80,80); pointer(canvas,"pointerup",80,80);
  await settle(); assert.equal(selected,null, "empty click clears");

  // Reproject and retry the click when its view changes while the query is pending.
  // Native renderers still expose the previous presented view during their frame listener.
  pointer(canvas,"pointerdown",20,30); pointer(canvas,"pointerup",20,30); frame();
  pointer(canvas,"pointermove",80,30);
  views.cameraCenterY = 70;
  controller.onFrame();
  await settle();
  assert.equal(selected?.kind,"stroke", "view change retries the completed click using the new projection");
  assert.equal(highlights.count,2, "retry refreshes hover at the latest cursor position after selection");
  views.cameraCenterY = 50;
  controller.onFrame();
  await settle();

  // A camera change can precede its frame notification while an async pick is running.
  canvas.ownerDocument.dispatchEvent(escape);
  pointer(canvas,"pointerdown",20,30); pointer(canvas,"pointerup",20,30); frame();
  views.cameraCenterY = 70;
  await settle();
  assert.equal(selected?.kind,"stroke", "async completion retries a changed view before its frame notification");
  views.cameraCenterY = 50;
  controller.onFrame();
  await settle();

  // Moving the cursor after a click must neither lose the selection nor revive old hover.
  canvas.ownerDocument.dispatchEvent(escape);
  pointer(canvas,"pointerdown",20,10); pointer(canvas,"pointerup",20,10); frame();
  pointer(canvas,"pointermove",80,80);
  await settle();
  assert.equal(selected?.kind,"stroke", "pointer movement does not cancel a completed click");
  assert.equal(highlights.count,1, "click result does not restore hover at the old cursor position");
  assert.equal(highlights.selectionCount,1);

  // A pending request cannot revive highlights after leaving or disabling.
  canvas.ownerDocument.dispatchEvent(escape);
  pointer(canvas,"pointermove",20,10); frame(); pointer(canvas,"pointerleave",120,10);
  await settle(); assert.equal(highlights,null);
  pointer(canvas,"pointerdown",20,10); pointer(canvas,"pointerup",20,10); frame();
  canvas.ownerDocument.dispatchEvent(escape);
  views.cameraCenterY = 70;
  controller.onFrame();
  await settle(); assert.equal(selected,null, "Escape prevents a later camera frame from reviving a completed click");
  assert.equal(highlights,null);
  views.cameraCenterY = 50;
  controller.onFrame();
  pointer(canvas,"pointerdown",20,10); pointer(canvas,"pointerup",20,10); frame(); controller.disable();
  views.cameraCenterY = 70;
  controller.onFrame();
  await settle(); assert.equal(highlights,null); assert.equal(selected,null);
  assert.equal(colorUpdates.at(-1)[0].color,null, "disable restores original color");
  views.cameraCenterY = 50;
  controller.enable(); controller.onFrame();
  const previousScene = scene;
  pointer(canvas,"pointerdown",20,10);
  scene = { ...previousScene }; controller.sceneChanged(); controller.onFrame();
  pointer(canvas,"pointerup",20,10);
  await settle(); assert.equal(selected,null, "old document gestures cannot select replacement geometry");
  pointer(canvas,"pointerdown",20,10); pointer(canvas,"pointerup",20,10); frame();
  scene = createEmptyVectorScene(); controller.sceneChanged();
  await settle(); assert.equal(selected,null); assert.equal(highlights,null);

  // Hover cancellation must not reset progress of the document-owned build.
  scene = previousScene; controller.sceneChanged();
  pointer(canvas,"pointermove",20,10); frame();
  assert.equal(preparation.at(-1), 0);
  pointer(canvas,"pointerleave",120,10);
  await settle();
  assert.equal(preparation.at(-1), 100, "shared preparation finishes even after pointer leave");
  assert.equal(highlights,null);

  scene = { ...previousScene }; controller.sceneChanged();
  pointer(canvas,"pointermove",20,10); frame();
  assert.equal(preparation.at(-1), 0);
  canvas = new Canvas(); renderer = rendererFactory(); controller.rendererChanged();
  assert.equal(preparation.at(-1), 0, "backend switch preserves in-flight progress");
  await settle(); assert.equal(preparation.at(-1), 100);

  scene = { ...previousScene }; controller.sceneChanged();
  pointer(canvas,"pointermove",20,10); frame();
  assert.equal(preparation.at(-1), 0);
  controller.disable();
  assert.equal(preparation.at(-1), null, "disabling clears preparation status immediately");
  const afterDisable = preparation.length;
  await settle(); assert.equal(preparation.length, afterDisable, "disposed build cannot restore progress");

  controller.enable();
  pointer(canvas,"pointermove",20,10); frame();
  assert.equal(preparation.at(-1), 0);
  scene = createEmptyVectorScene(); controller.sceneChanged();
  assert.equal(preparation.at(-1), null);
  const afterReplacement = preparation.length;
  await settle(); assert.equal(preparation.length, afterReplacement, "old document cannot update the new document's progress");
  controller.dispose(); assert.equal(frames.size,0); assert.deepEqual(errors,[]);

  console.log("Primitive viewer interaction tests passed.");
} finally {
  hooks.deregister();
  if (originalRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = originalRaf;
  if (originalCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = originalCancel;
}
