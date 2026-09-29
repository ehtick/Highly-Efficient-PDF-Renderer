import assert from "node:assert/strict";
import { createProgressLogger } from "../PDFtoHEP.js";

// No PDF conversion or source loader: only the CLI's output policy.
let time = 0;
const lines = [];
const progress = createProgressLogger("book.pdf", 2, 17, {
  now: () => time,
  write: line => lines.push(line)
});
progress({ stage: "source", value: 0 });
for (let page = 0; page < 1259; page++) {
  for (const stage of ["operators", "optimize", "text"]) {
    time += 5;
    progress({ stage, value: .16 + page / 1259 * .66 });
  }
}
assert(lines.length < 100, "page-stage churn must not produce thousands of terminal writes");
progress({ stage: "hep-build", value: .85 });
assert(lines.at(-1).endsWith("85% hep-build"), "percentage milestones remain immediate");
progress({ stage: "complete", value: 1 });
assert(lines.at(-1).endsWith("100% complete"), "completion must never be throttled");
const count = lines.length;
progress({ stage: "complete", value: 1 });
assert.equal(lines.length, count, "duplicate completion is silent");

const sparse = [];
const slow = createProgressLogger("cad.pdf", 1, 1, { now: () => time, write: line => sparse.push(line) });
slow({ stage: "operators", value: .4 });
time += 300;
slow({ stage: "optimize", value: .4 });
assert.equal(sparse.length, 2, "slow stage transitions stay visible without a percentage change");
console.log("PDF-to-HEP progress bounds terminal writes and preserves milestones and completion.");
