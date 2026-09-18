import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDrawingSelectionControls } from "../src/drawingSelectionControls.ts";

// A small DOM host for exercising the widget's event/state contract without a
// browser, renderer, or document conversion.
class Element extends EventTarget {
  attributes = new Map();
  checked = false;
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
}
class Container extends Element {
  elements = new Map();
  set innerHTML(html) {
    this.elements.clear();
    for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const node = new Element();
      node.hidden = /\bhidden\b/.test(match[0]);
      node.disabled = /\bdisabled\b/.test(match[0]);
      node.value = match[0].match(/\bvalue="([^"]+)"/)?.[1] ?? "";
      // Simulate a browser restoring a previously checked form control.
      node.checked = match[1] === "drawing-selection-checkbox";
      this.elements.set(match[1], node);
    }
  }
  querySelector(selector) { return this.elements.get(selector.slice(1)) ?? null; }
  replaceChildren() { this.elements.clear(); }
}

const container = new Container(), calls = [];
let callbacks, enabled = false, textSelectionEnabled = true;
const widget = createDrawingSelectionControls({
  container,
  createController(value) {
    callbacks = value;
    return {
      enable() { calls.push("enable"); enabled = true; },
      disable() {
        calls.push("disable"); enabled = false;
        callbacks.onPreparationProgress(null);
        callbacks.onSelectionChange(null);
      },
      isEnabled: () => enabled,
      setSelectedColor: value => calls.push(["color", value]),
      resetSelectedColor: () => calls.push("reset-selected"),
      resetAllColors: () => calls.push("reset-all"),
      sceneChanged: () => calls.push("scene"),
      rendererChanged: () => calls.push("renderer"),
      onFrame: () => calls.push("frame"),
      dispose: () => calls.push("dispose")
    };
  },
  onEnabledChange(value) {
    calls.push(["enabled", value]);
    textSelectionEnabled = !value;
  }
});
const node = suffix => container.querySelector(`#drawing-selection-${suffix}`);
const checkbox = node("checkbox"), controls = node("controls"), loading = node("loading");
const info = node("info"), progress = node("progress"), color = node("color"), reset = node("reset");
assert.equal(checkbox.checked, false, "drawing selection is never restored by browser form state");
assert.equal(widget.isEnabled(), false);
assert.equal(controls.hidden, true);
assert.equal(loading.hidden, true);
assert.equal(color.disabled, true);
assert.equal(reset.disabled, true);
assert.deepEqual(calls, [], "mounting controls does not start picking or change text-selection preferences");

checkbox.checked = true;
checkbox.dispatchEvent(new Event("change"));
assert.deepEqual(calls, [["enabled", true], "enable"], "suspend text gestures before enabling drawing gestures");
assert.equal(textSelectionEnabled, false);
assert.equal(controls.hidden, false);
assert.equal(widget.isEnabled(), true);
for (const percentage of [0, 47, 99]) {
  callbacks.onPreparationProgress(percentage);
  assert.equal(loading.hidden, false);
  assert.equal(info.hidden, true);
  assert.equal(progress.value, percentage);
  assert.equal(node("loading-label").textContent, `Preparing drawing selection… ${percentage}%`);
  assert.equal(controls.getAttribute("aria-busy"), "true");
}
callbacks.onPreparationProgress(100);
assert.equal(loading.hidden, true);
assert.equal(info.hidden, false);
assert.equal(controls.getAttribute("aria-busy"), "false");

const primitive = { kind: "stroke", index: 42, pageIndex: 1, segmentCount: 1,
  bounds: { minX: 0, minY: 1, maxX: 10, maxY: 11 }, color: [0, 0, 0] };
callbacks.onSelectionChange(primitive, [1, 0.5, 0]);
assert.match(info.textContent, /stroke 42 · Page 2 · 1 segments/);
assert.match(info.textContent, /\(0\.00, 1\.00\)–\(10\.00, 11\.00\)/);
assert.equal(color.value, "#ff8000", "selection shows the current temporary color");
assert.equal(color.disabled, false);
assert.equal(reset.disabled, false);
color.value = "#ff0000";
color.dispatchEvent(new Event("input"));
reset.dispatchEvent(new Event("click"));
node("reset-all").dispatchEvent(new Event("click"));
assert.deepEqual(calls.slice(-3), [["color", "#ff0000"], "reset-selected", "reset-all"]);
callbacks.onSelectionChange({ ...primitive, kind: "raster", color: null, pageIndex: null });
assert.match(info.textContent, /^raster 42/);
assert(!info.textContent.includes("Page"));
assert.equal(color.disabled, true, "rasters are inspectable but cannot be recolored");
assert.equal(reset.disabled, true);
callbacks.onSelectionChange(null);
assert.equal(info.textContent, "Hover or click a drawing element.");

callbacks.onPreparationProgress(25);
widget.disable();
assert.equal(checkbox.checked, false, "programmatic disable keeps the checkbox in sync");
assert.equal(controls.hidden, true);
assert.equal(loading.hidden, true);
assert.equal(textSelectionEnabled, true);
assert.deepEqual(calls.slice(-2), ["disable", ["enabled", false]], "restore text gestures after releasing drawing interaction");
widget.enable();
assert.equal(checkbox.checked, true);
widget.sceneChanged(); widget.rendererChanged(); widget.onFrame();
assert.deepEqual(calls.slice(-3), ["scene", "renderer", "frame"], "lifecycle calls reach the library controller");
widget.dispose();
assert.deepEqual(calls.slice(-3), ["disable", ["enabled", false], "dispose"]);
assert.equal(container.elements.size, 0);
const callsAfterDispose = calls.length;
checkbox.dispatchEvent(new Event("change"));
color.dispatchEvent(new Event("input"));
reset.dispatchEvent(new Event("click"));
widget.enable(); widget.dispose();
assert.equal(calls.length, callsAfterDispose, "disposed widgets detach listeners and cannot restart interaction");
callbacks.onPreparationProgress(75);
assert.equal(loading.hidden, true, "late callbacks cannot revive disposed UI");

for (const demo of ["main", "three-example", "room-overlay-demo"]) {
  const source = await readFile(new URL(`../src/${demo}.ts`, import.meta.url), "utf8");
  const html = await readFile(new URL(`../${demo === "main" ? "index" : demo}.html`, import.meta.url), "utf8");
  assert.match(html, /id="drawing-selection"/, `${demo} provides a controls mount`);
  assert.match(source, /createDrawingSelectionControls\(/, `${demo} uses the shared widget`);
  assert.match(source, /drawingSelection\.onFrame\(/, `${demo} invalidates picks on view changes`);
  assert.match(source, /drawingSelection\.sceneChanged\(/, `${demo} resets document-specific state`);
  if (demo !== "main") assert.match(html, /drawingSelectionControls\.css/, `${demo} includes shared cursor/progress styles`);
}
console.log("Shared drawing selection controls: defaults, progress, inspection, styling, lifecycle and demo wiring passed.");
