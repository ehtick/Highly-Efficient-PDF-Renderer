import assert from "node:assert/strict";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const hooks = registerHooks({ resolve(s, c, next) {
  return c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? next(`${s}.ts`, c) : next(s, c);
} });

class Element extends EventTarget {
  children = []; style = {}; attributes = new Map(); hidden = false; textContent = "";
  offsetWidth = 180; offsetHeight = 80;
  constructor(document) { super(); this.ownerDocument = document; }
  set innerHTML(_) { throw new Error("PDF strings must never become HTML"); }
  setAttribute(k, v) { this.attributes.set(k, v); }
  appendChild(child) { child.parent = this; this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  contains(child) { return this === child || this.children.some(c => c.contains(child)); }
  remove() { this.parent.children = this.parent.children.filter(c => c !== this); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 200 }; }
}
class Window extends EventTarget {
  innerWidth = 400; innerHeight = 300; frames = new Map(); nextId = 1;
  requestAnimationFrame(callback) { const id = this.nextId++; this.frames.set(id, callback); return id; }
  cancelAnimationFrame(id) { this.frames.delete(id); }
  frame() { const callbacks = [...this.frames.values()]; this.frames.clear(); for (const cb of callbacks) cb(); }
}
function annotation(index, bounds, extra = {}) {
  return { id: `ref:${index}:0`, sourcePageIndex: 4, pageIndex: 0, annotationIndex: index, subtype: "Square",
    bounds, pdfGeometry: { rect: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY] },
    flags: 0, visibleInDefaultView: true, hasAppearance: true, contents: `Comment ${index}`, ...extra };
}
function text(element) { return element.textContent + element.children.map(text).join(""); }

try {
  const { createAnnotationOverlay, pickSceneAnnotation } = await import("../src/annotationOverlay.ts");
  const { createEmptyVectorScene } = await import("../src/emptyVectorScene.ts");
  const window = new Window();
  const document = { defaultView: window, createElement: () => new Element(document) };
  document.body = new Element(document);
  let canvas = new Element(document), suppressed = false, shift = 0, visibility = null;
  const annotations = [
    annotation(0, { minX: 5, minY: 5, maxX: 95, maxY: 95 }),
    annotation(1, { minX: 10, minY: 10, maxX: 30, maxY: 30 }, { contents: "<img src=x onerror=bad()>" }),
    annotation(2, { minX: 40, minY: 10, maxX: 70, maxY: 30 }, { subtype: "Popup" }),
    annotation(3, { minX: 40, minY: 40, maxX: 70, maxY: 70 }, { subtype: "Underline",
      quadPoints: [40, 70, 70, 70, 40, 60, 70, 60, 40, 50, 70, 50, 40, 40, 70, 40] }),
    annotation(4, { minX: 110, minY: 10, maxX: 180, maxY: 30 }, { subtype: "Ink", inkList: [[110, 20, 180, 20]] }),
    annotation(5, { minX: 210, minY: 10, maxX: 230, maxY: 30 }, { flags: 32 }),
    annotation(6, { minX: 210, minY: 50, maxX: 230, maxY: 70 }, { optionalContent: 0, visibleInDefaultView: false }),
    annotation(7, { minX: 280, minY: 150, maxX: 340, maxY: 180 })
  ];
  let scene = { ...createEmptyVectorScene(), annotations, pageCount: 1, pageRects: Float32Array.of(0, 0, 300, 200),
    optionalContent: { groups: [], conditions: [{ kind: "constant", value: false }], order: [], radioGroups: [] } };
  const adapter = {
    getScene: () => scene, getOptionalContentVisibility: () => visibility,
    clientToScenePoint: (x, y) => ({ x: x - shift, y }), sceneToClientPoint: (x, y) => ({ x: x + shift, y }),
    isInteractionSuppressed: () => suppressed
  };
  assert.equal(pickSceneAnnotation(scene, 20, 20, adapter), annotations[1], "smaller overlapping annotation wins");
  assert.equal(pickSceneAnnotation(scene, 50, 55, adapter), annotations[0], "multiline bounding-box gaps are not markup hits");
  assert.equal(pickSceneAnnotation(scene, 50, 65, adapter), annotations[3]);
  assert.equal(pickSceneAnnotation(scene, 150, 23, adapter), annotations[4]);
  assert.equal(pickSceneAnnotation(scene, 150, 29, adapter), null, "ink tests distance to the stroke");
  annotations[4].border = { width: 12 };
  assert.equal(pickSceneAnnotation(scene, 150, 29, adapter), annotations[4], "ink proximity includes source stroke width");
  delete annotations[4].border;
  const duplicate = { ...annotations[1], contents: "Later annotation" };
  scene.annotations = [...annotations, duplicate];
  assert.equal(pickSceneAnnotation(scene, 20, 20, adapter), duplicate, "ties use reverse collection order");
  scene.annotations = annotations;
  assert.equal(pickSceneAnnotation(scene, 220, 20, adapter), null, "NoView hides the hit area");
  assert.equal(pickSceneAnnotation(scene, 220, 60, adapter), null, "layer default hides the hit area");
  assert.equal(pickSceneAnnotation(scene, 320, 160, adapter), null, "page crop clips hit areas");
  // Execute the native example's actual bindings in source order. Its overlay
  // reads the scene during construction, before the renderer is assigned.
  const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const startupBindings = [
    mainSource.match(/^let lastParsedScene:[^\n]+;/m),
    mainSource.match(/^const annotationOverlay = createAnnotationOverlay\(\{[\s\S]*?^\}\);/m)
  ];
  assert(startupBindings.every(Boolean), "native example startup bindings exist");
  const startup = vm.createContext({
    createAnnotationOverlay, canvasElement: canvas, renderer: undefined,
    annotationBubblesCheckbox: { checked: true },
    drawingSelection: { isEnabled: () => false },
    textSelection: { getSelectedText: () => "" },
    fixtureScene: scene,
    fixtureRenderer: { getOptionalContentVisibility: () => visibility,
      clientToScenePoint: adapter.clientToScenePoint, sceneToClientPoint: adapter.sceneToClientPoint }
  });
  vm.runInContext(stripTypeScriptTypes(startupBindings.sort((a, b) => a.index - b.index)
    .map(match => match[0]).join("\n")), startup);
  vm.runInContext("annotationOverlay.onFrame()", startup);
  vm.runInContext("renderer = fixtureRenderer; lastParsedScene = fixtureScene; annotationOverlay.show(lastParsedScene.annotations[1])", startup);
  assert.equal(document.body.children[0].hidden, false, "native overlay opens after renderer and document initialization");
  vm.runInContext("annotationOverlay.dispose()", startup);
  assert.equal(document.body.children.length, 0);

  const overlay = createAnnotationOverlay({ getCanvas: () => canvas, adapter });
  const panel = document.body.children[0];
  const event = (type, x = 20, y = 20, extra = {}, target = canvas) => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, "target", { value: target });
    Object.assign(e, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0,
      buttons: type === "pointerdown" ? 1 : 0, ...extra });
    window.dispatchEvent(e); return e;
  };
  event("pointermove"); window.frame();
  assert.equal(panel.hidden, false); assert(text(panel).includes("<img src=x onerror=bad()>"));
  assert.equal(document.body.children.length, 1, "only one bubble element");
  const down = event("pointerdown"); event("pointerup");
  assert.equal(down.defaultPrevented, false, "camera and selection retain their pointer events");
  event("pointermove", 50, 65); window.frame();
  assert(text(panel).includes("<img"), "hover cannot replace a pinned bubble");
  event("pointerdown", 50, 65); event("pointerup", 50, 65);
  assert(text(panel).includes("Comment 3"), "click replaces the pinned annotation");
  const oldLeft = panel.style.left;
  shift = 10; overlay.onFrame();
  assert.notEqual(panel.style.left, oldLeft, "pin follows view projection");
  canvas = new Element(document); overlay.sceneChanged(); overlay.onFrame();
  assert.equal(panel.hidden, false, "backend canvas changes preserve the same scene's pin");
  event("keydown", 0, 0, { key: "Escape" }); window.frame();
  assert.equal(panel.hidden, true);
  event("pointerdown", 30, 20); event("pointermove", 80, 30, { buttons: 1 }); event("pointerup", 80, 30);
  assert.equal(panel.hidden, true, "dragging never pins");
  event("pointerdown", 30, 20); event("pointerdown", 30, 20, { pointerId: 2 });
  event("pointerup", 30, 20, { pointerId: 2 }); event("pointerup", 30, 20);
  assert.equal(panel.hidden, true, "multitouch gestures never pin");
  overlay.show(annotations[6]); assert.equal(panel.hidden, true);
  visibility = { revision: 1, layers: [], conditions: Uint8Array.of(1) };
  overlay.show(annotations[6]); assert.equal(panel.hidden, false);
  visibility = { revision: 2, layers: [], conditions: Uint8Array.of(0) }; overlay.onFrame();
  assert.equal(panel.hidden, true, "hidden layer dismisses its pin");
  suppressed = true; event("pointermove", 30, 20); window.frame(); assert.equal(panel.hidden, true);
  suppressed = false; overlay.show(annotations[1]); assert.equal(panel.hidden, false);
  overlay.disable(); assert.equal(panel.hidden, true); assert.equal(overlay.isEnabled(), false);
  overlay.enable(); overlay.show(annotations[1]);
  scene = { ...scene }; overlay.sceneChanged(); assert.equal(panel.hidden, true, "new document dismisses pin");
  overlay.dispose(); overlay.dispose(); assert.equal(document.body.children.length, 0);
  event("pointermove"); window.frame(); assert.equal(document.body.children.length, 0);
  console.log("Annotation overlay: precise picking, safe HTML text, pinning, gestures, visibility, projection and lifecycle passed.");
} finally { hooks.deregister(); }
