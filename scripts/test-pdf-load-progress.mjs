import assert from "node:assert/strict";

import {
  createLoadProgressReporter,
  formatLoadProgressStage
} from "../src/loadProgress.ts";

assert.equal(formatLoadProgressStage("pdf-page"), "Processing pages");
assert.equal(formatLoadProgressStage("pdf-operators"), "Scanning operators");
assert.equal(formatLoadProgressStage("pdf-optimize"), "Optimizing geometry");

const directEvents = [];
const directReporter = createLoadProgressReporter(
  (event) => directEvents.push(event),
  { throttleMs: 0, minDelta: 0 }
);

directReporter.report(0.1, {
  stage: "pdf-operators",
  executionPath: "worker",
  sourceType: "pdf",
  unit: "bytes",
  processed: 10,
  total: 100
});
directReporter.report(0.2, {
  stage: "pdf-optimize",
  executionPath: "worker",
  sourceType: "pdf",
  unit: "bytes",
  processed: 20,
  total: 100
});

assert.deepEqual(
  directEvents.map(({ stage, executionPath }) => ({ stage, executionPath })),
  [
    { stage: "pdf-operators", executionPath: "worker" },
    { stage: "pdf-optimize", executionPath: "worker" }
  ]
);

const indeterminateEvents = [];
const indeterminateReporter = createLoadProgressReporter(
  (event) => indeterminateEvents.push(event),
  { throttleMs: 0, minDelta: 0 }
);

await indeterminateReporter.withIndeterminateProgress(Promise.resolve("done"), {
  stage: "pdf-operators",
  executionPath: "worker",
  sourceType: "pdf"
});

assert.ok(indeterminateEvents.length >= 2);
assert.ok(
  indeterminateEvents.every(
    (event) =>
      event.stage === "pdf-operators" &&
      event.executionPath === "worker" &&
      event.sourceType === "pdf"
  )
);

console.log("PDF load progress tests passed.");
