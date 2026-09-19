import assert from "node:assert/strict";
import { test } from "node:test";
import { createDrawCallMeter, createThreeDrawCallCounter } from "../src/drawCallMetrics.ts";

function createMeterHarness(t, options) {
  let now = 0;
  let text = "-";
  const writes = [];
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const meter = createDrawCallMeter({
    get textContent() { return text; },
    set textContent(value) { text = value; writes.push(value); }
  }, options);
  return {
    meter,
    writes,
    get text() { return text; },
    advance(milliseconds) { now += milliseconds; t.mock.timers.tick(milliseconds); }
  };
}

test("draw-call HUD throttles writes and eventually displays the last on-demand frame", t => {
  const hud = createMeterHarness(t);
  hud.meter.update(1234);
  assert.equal(hud.text, (1234).toLocaleString());
  hud.advance(10);
  hud.meter.update(12);
  hud.advance(10);
  hud.meter.update(7);
  assert.equal(hud.writes.length, 1);
  hud.advance(80);
  assert.equal(hud.text, "7", "a trailing timer must publish the idle frame without another render");
  hud.advance(100);
  hud.meter.update(7);
  assert.equal(hud.writes.length, 2, "an unchanged count must not write to the DOM");
  hud.advance(100);
  hud.meter.update(0);
  assert.equal(hud.text, "0", "a frame without draws is a known zero");
  hud.advance(100);
  hud.meter.update(undefined);
  assert.equal(hud.text, "-", "missing instrumentation must not be reported as zero");
  hud.meter.dispose();
});

test("reset and disposal discard pending HUD values", t => {
  const controller = new AbortController();
  const hud = createMeterHarness(t, { signal: controller.signal });
  hud.meter.update(5);
  hud.advance(10);
  hud.meter.update(9);
  hud.meter.reset();
  assert.equal(hud.text, "-");
  hud.meter.update(2);
  assert.equal(hud.text, "2", "a new document's first frame must update immediately");
  hud.advance(100);
  assert.equal(hud.text, "2", "the previous document's queued frame must stay discarded");
  hud.meter.update(3);
  hud.advance(10);
  hud.meter.update(4);
  controller.abort();
  hud.advance(100);
  hud.meter.update(6);
  assert.equal(hud.text, "3", "aborting the demo cancels pending and subsequent HUD writes");
});

function createWebGlInfo() {
  return {
    autoReset: true,
    render: { calls: 200 },
    reset() { this.render.calls = 0; }
  };
}

test("Three counts the entire nested render and only native draws from that frame", () => {
  const counter = createThreeDrawCallCounter();
  const info = createWebGlInfo();
  const drawPass = calls => {
    if (info.autoReset) info.reset();
    info.render.calls += calls;
  };
  counter.recordNativeFrame(100);
  assert.equal(counter.measure(info, () => {
    assert.equal(info.autoReset, false);
    drawPass(3);
    counter.recordNativeFrame(4);
    drawPass(2);
    counter.recordNativeFrame(1);
  }), 10, "nested compositor, presentation, and native calls belong to one displayed frame");
  assert.equal(info.autoReset, true);
  counter.recordNativeFrame(100);
  assert.equal(counter.measure(info, () => drawPass(1)), 1,
    "a reused native texture must not carry its previous frame's draw count forward");
  assert.equal(counter.measure(info, () => {}), 0);
});

test("Three WebGPU reads GPU draws instead of its cumulative render invocation count", () => {
  const counter = createThreeDrawCallCounter();
  const info = {
    autoReset: false,
    render: { calls: 300, drawCalls: 100 },
    reset() { this.render.drawCalls = 0; }
  };
  assert.equal(counter.measure(info, () => {
    info.render.calls += 3;
    info.render.drawCalls += 7;
    counter.recordNativeFrame(2);
  }), 9);
  assert.equal(info.autoReset, false, "the caller's reset policy must be preserved");
  assert.equal(counter.measure(info, () => { info.render.calls++; }), 0);
});

test("Three restores reset state on errors and reports unavailable native instrumentation", () => {
  const counter = createThreeDrawCallCounter();
  const info = createWebGlInfo();
  assert.throws(() => counter.measure(info, () => { throw new Error("render failed"); }), /render failed/);
  assert.equal(info.autoReset, true);
  counter.recordNativeFrame(100);
  assert.equal(counter.measure(info, () => { info.render.calls++; }), 1);
  assert.equal(counter.measure(info, () => {
    info.render.calls++;
    counter.recordNativeFrame(undefined);
  }), null);
  assert.equal(counter.measure(info, () => { info.render.calls += 2; }), 2);
});
