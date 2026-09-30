import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { tinyPdfStream, writeTinyPdf } from "./lib/tinyPdfWriter.mjs";

const hooks = registerHooks({ resolve(s, c, next) {
  return c.parentURL?.includes("/src/") && /^\.\.?\//.test(s) && !/\.[a-z0-9]+$/i.test(s) ? next(`${s}.ts`, c) : next(s, c);
} });

try {
  const { openPdf } = await import("../src/pdfSession.ts");
  const { encodeHeprPageData, decodeHeprPageData } = await import("../src/heprPageEncoding.ts");
  const { composeVectorScenesInGrid } = await import("../src/pdfVectorExtractor.ts");
  const { buildNativeRasterPage } = await import("../src/pdf/nativeRasterPage.ts");
  const { validateAnnotations } = await import("../src/annotationData.ts");
  const session = await openPdf({ kind: "bytes", bytes: fixture() });
  try {
    const annotations = await session.getPageAnnotations(0);
    assert.equal(annotations.length, 8);
    const [comment, popup, reply, field, link, hidden, unknown, malformed] = annotations;
    assert.deepEqual(annotations.map(a => a.annotationIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(comment.contents, "Café 😀");
    assert.equal(comment.author, "Author");
    assert.equal(comment.tooltip, "Helpful • tip");
    assert.equal(comment.name, "unique-comment");
    assert.deepEqual(comment.pdfGeometry.rect, [70, 60, 30, 40]);
    assert.deepEqual(comment.bounds, { minX: 40, minY: 240, maxX: 80, maxY: 320 });
    assert.deepEqual(comment.color, [1, 0.5, 0]);
    assert.deepEqual(comment.border, { width: 2, style: "D", dash: [2, 1] });
    assert.equal(comment.opacity, 0.5);
    assert.equal(comment.popupId, popup.id);
    assert.equal(popup.parentId, comment.id);
    assert.equal(popup.open, true);
    assert.equal(reply.replyToId, comment.id);
    assert.equal(reply.replyType, "R");
    assert.equal(field.tooltip, "Parent tooltip");
    assert.equal(field.field.name, "Agreement");
    assert.equal(field.field.type, "Btn");
    assert.equal(field.field.value, "Yes");
    assert.equal(field.field.flags, 1);
    assert.equal(field.author, undefined, "field /T is not a comment author");
    assert.equal(hidden.visibleInDefaultView, false);
    assert.equal(hidden.contents, "Hidden metadata");
    assert.equal(unknown.subtype, "FutureAnnot");
    assert.equal(unknown.action.type, "JavaScript");
    assert.equal(Object.hasOwn(unknown.action, "JS"), false, "unsupported actions are inert type descriptions");
    assert.equal(link.action.uri, "relative/path");
    assert.equal(link.action.uriBase, "https://example.invalid/");
    assert.equal(link.action.next[0].destination.sourcePageIndex, 1);
    assert.equal(link.action.next[0].destination.name, "Target");
    assert.deepEqual(link.action.next[0].destination.parameters, [12, 34, null]);
    assert.equal(link.action.next[1].destination.remotePageIndex, 3);
    assert.equal(link.action.next[1].file, "other.pdf");
    assert.equal(link.action.next[2].name, "NextPage");
    assert.equal(malformed.contents, undefined);
    assert.equal(malformed.subject, "Still usable");
    assert(session.getDiagnostics().some(d => d.code === "annotation.metadata-invalid"));
    comment.contents = "caller mutation";
    assert.equal((await session.getPageAnnotations(0))[0].contents, "Café 😀", "caller metadata is detached from the cache");
    await assert.rejects(session.getPageAnnotations(0, { signal: AbortSignal.abort() }), e => e.code === "aborted");
    await assert.rejects(session.getPageAnnotations(9), e => e.code === "invalid-page-index");
    const page = await session.compilePage(0);
    assert.equal(page.annotations.length, 8);
    const encoded = decodeHeprPageData(encodeHeprPageData(page));
    assert.deepEqual(encoded.annotations, JSON.parse(JSON.stringify(page.annotations)));
    const oldPage = { ...page }; delete oldPage.annotations;
    assert.equal(decodeHeprPageData(encodeHeprPageData(oldPage)).annotations, undefined);
    const raster = buildNativeRasterPage(page, { rgba: new Uint8ClampedArray(4), width: 1, height: 1, scale: 1 }, new AbortController().signal);
    assert.equal(raster.annotations.length, 8);
    const first = await session.compileVectorPage(0);
    const second = await session.compileVectorPage(1);
    assert.deepEqual(first.pdfPages, raster.pdfPages, "raster fallback retains destination mapping");
    assert.deepEqual(second.pdfPages, [{ sourcePageIndex: 1, pageIndex: 0, pdfToScene: [1, -0, 0, 1, 0, 0] }]);
    assert.deepEqual(second.annotations, []);
    assert.deepEqual(await session.getPageAnnotations(1), []);
    const composed = composeVectorScenesInGrid([second, first], 2);
    assert.deepEqual(composed.pdfPages.map(p => [p.sourcePageIndex, p.pageIndex]), [[1, 0], [0, 1]]);
    const placed = composed.annotations.find(a => a.id === reply.id);
    assert.equal(placed.sourcePageIndex, 0);
    assert.equal(placed.pageIndex, 1);
    assert.equal(placed.replyToId, comment.id);
    const before = first.annotations.find(a => a.id === reply.id);
    assert.equal(placed.bounds.minX - before.bounds.minX, composed.pageRects[4] - first.pageRects[0]);
    assert.equal(placed.bounds.minY - before.bounds.minY, composed.pageRects[5] - first.pageRects[1]);
    assert.deepEqual(placed.pdfGeometry, before.pdfGeometry);
    validateAnnotations(composed.annotations, { pageCount: 2, conditionCount: 0 });
    await assert.rejects(session.compilePage(0, { limits: { maxCommandsPerPage: 2 } }), e => e.code === "resource-limit");
  } finally { await session.close(); }
  await assert.rejects(session.getPageAnnotations(0), e => e.code === "closed");

  // Metadata discovery must not compile the page or resolve an unusable /AP stream.
  const lazy = await openPdf({ kind: "bytes", bytes: fixture({ lazy: true }) });
  try { assert.equal((await lazy.getPageAnnotations(0)).length, 8); }
  finally { await lazy.close(); }

  const malformedFields = await openPdf({ kind: "bytes", bytes: fixture({ malformedWidget: true }) });
  try {
    const field = (await malformedFields.getPageAnnotations(0))[3];
    assert.equal(field.tooltip, "Parent tooltip");
    assert.equal(field.field.type, "Btn");
    assert.equal(field.field.flags, 0);
    assert.equal(field.field.value, "Yes");
    assert.equal(field.field.name, undefined);
    assert(malformedFields.getDiagnostics().some(d => d.code === "annotation.metadata-invalid"));
  } finally { await malformedFields.close(); }

  for (const rotation of [0, 90, 180, 270]) {
    const rotated = await openPdf({ kind: "bytes", bytes: fixture({ rotation }) });
    try {
      const a = (await rotated.getPageAnnotations(0))[0];
      const expected = { 0: [40, 40, 120, 80], 90: [40, 240, 80, 320],
        180: [240, 160, 320, 200], 270: [160, 40, 200, 120] }[rotation];
      assert.deepEqual(Object.values(a.bounds), expected);
    } finally { await rotated.close(); }
  }
  const actions = await openPdf({ kind: "bytes", bytes: fixture({ cyclicActions: true }) });
  try {
    const link = (await actions.getPageAnnotations(0))[4];
    assert.equal(link.action.type, "URI");
    assert.equal(link.action.next.length, 1);
    assert.equal(link.action.next[0].name, "NextPage");
    assert.equal(link.destination.name, "Unresolved");
    assert(actions.getDiagnostics().some(d => d.code === "annotation.metadata-invalid"));
  } finally { await actions.close(); }
  const countLimited = await openPdf({ kind: "bytes", bytes: fixture() }, { limits: { maxCommandsPerPage: 2 } });
  try { await assert.rejects(countLimited.getPageAnnotations(0), e => e.code === "resource-limit"); }
  finally { await countLimited.close(); }
  const limited = await openPdf({ kind: "bytes", bytes: fixture(), }, { limits: { maxPathCoordinatesPerPage: 4 } });
  try { await assert.rejects(limited.getPageAnnotations(0), e => e.code === "resource-limit"); }
  finally { await limited.close(); }

  // Identity contract: ids come from the /Annots entry, never from counters.
  const identitySessions = [await openPdf({ kind: "bytes", bytes: identityFixture() }), await openPdf({ kind: "bytes", bytes: identityFixture() })];
  try {
    const [first, second] = identitySessions;
    const page = await first.getPageAnnotations(0);
    assert.deepEqual(page.map(a => a.id), ["ref:5:0", "page:0:annotation:1", "ref:7:0"],
      "indirect annotations use their object reference; inline ones their source position");
    assert.deepEqual(page.map(a => a.annotationIndex), [0, 1, 3], "source indexes survive a skipped repeat");
    assert.deepEqual(page.map(a => a.name), ["square-guid", undefined, "note-guid"]);
    const duplicate = first.getDiagnostics().find(d => d.code === "annotation.duplicate-reference");
    assert.equal(duplicate?.pageIndex, 0);
    assert.equal(duplicate?.details?.duplicateCount, 1);
    assert.deepEqual((await first.getPageAnnotations(1)).map(a => a.id), ["ref:7:0"],
      "one object shared by two pages keeps its id on each page");
    assert.deepEqual((await second.getPageAnnotations(0)).map(a => a.id), page.map(a => a.id), "ids are deterministic");
    const scene = await first.compileVectorPage(0, {});
    assert.equal(scene.segmentCount, 8, "the repeated Square is drawn once (plus the inline Square)");
    assert.deepEqual(scene.annotations.map(a => a.id), page.map(a => a.id));
  } finally { for (const session of identitySessions) await session.close(); }
  console.log("Annotation metadata: strings, fields, relationships, actions, geometry, laziness, lifetime, page/scene preservation and identity passed.");
} finally { hooks.deregister(); }

function identityFixture() {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Count 2 /Kids [3 0 R 8 0 R] >>" },
    { number: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [5 0 R " +
      "<< /Subtype /Square /Rect [10 10 30 30] /AP << /N 6 0 R >> >> 5 0 R 7 0 R] >>" },
    { number: 4, body: tinyPdfStream("", "") },
    { number: 5, body: "<< /Subtype /Square /Rect [50 50 110 110] /NM (square-guid) /AP << /N 6 0 R >> >>" },
    { number: 6, body: tinyPdfStream("/Subtype /Form /BBox [0 0 10 10]", "1 0 0 RG 1 w 1 1 8 8 re S") },
    { number: 7, body: "<< /Subtype /Text /Rect [150 150 160 160] /F 2 /NM (note-guid) >>" },
    { number: 8, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Annots [7 0 R] >>" }
  ] });
}

function fixture({ lazy = false, rotation = 90, malformedWidget = false, cyclicActions = false } = {}) {
  return writeTinyPdf({ objects: [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [16 0 R] >> /Names << /Dests 20 0 R >> /URI << /Base (https://example.invalid/) >> >>" },
    { number: 2, body: "<< /Type /Pages /Count 2 /Kids [3 0 R 18 0 R] >>" },
    { number: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 160] /CropBox [10 20 190 140] /Rotate ${rotation} /UserUnit 2 /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 11 0 R 12 0 R 13 0 R] >>` },
    { number: 4, body: tinyPdfStream(lazy ? "/Filter /NotAFilter" : "", "0 0 0 rg 10 20 4 4 re f") },
    { number: 5, body: "<< /Subtype /Square /Rect [70 60 30 40] /Contents <feff00430061006600e90020d83dde00> /TU <48656c7066756c208020746970> /T (Author) /Subj (Subject) /NM (unique-comment) /CreationDate (D:20240102030405Z) /M (D:20240203040506Z) /C [1 .5 0] /CA .5 /BS << /W 2 /S /D /D [2 1] >> /Popup 6 0 R /AP << /N 10 0 R >> >>" },
    { number: 6, body: "<< /Subtype /Popup /Rect [0 -20 100 0] /Parent 5 0 R /Open true >>" },
    { number: 7, body: "<< /Subtype /Text /Rect [80 60 90 70] /Contents <efbbbf5265706c7920e29c93> /Name /Comment /IRT 5 0 R /RT /R >>" },
    { number: 8, body: "<< /Subtype /Widget /Parent 16 0 R /Rect [20 100 30 110] /AP << /N 10 0 R >> >>" },
    { number: 9, body: cyclicActions ? "<< /Subtype /Link /Rect [30 80 60 90] /Dest (Unresolved) /A 22 0 R >>" : "<< /Subtype /Link /Rect [30 80 60 90] /QuadPoints [30 90 60 90 30 80 60 80] /Border [0 0 0] /A << /S /URI /URI (relative/path) /Next [<< /S /GoTo /D (Target) >> << /S /GoToR /F << /UF (other.pdf) >> /D [3 /Fit] >> << /S /Named /N /NextPage >>] >> >>" },
    { number: 10, body: tinyPdfStream(lazy ? "/Subtype /Form /BBox [0 0 10 10] /Filter /NotAFilter" : "/Subtype /Form /BBox [0 0 10 10]", "0 0 1 rg 0 0 10 10 re f") },
    { number: 11, body: "<< /Subtype /Text /Rect [100 60 110 70] /F 2 /Contents (Hidden metadata) >>" },
    { number: 12, body: "<< /Subtype /FutureAnnot /Rect [110 60 120 70] /Contents (Unknown metadata) /A << /S /JavaScript /JS (not executed) >> >>" },
    { number: 13, body: "<< /Subtype /Text /Rect [120 60 130 70] /Contents 42 /Subj (Still usable) >>" },
    { number: 16, body: `<< /FT /Btn /T ${malformedWidget ? "42" : "(Agreement)"} /TU (Parent tooltip) /Ff ${malformedWidget ? "(invalid)" : "1"} /V /Yes /Kids [8 0 R] >>` },
    { number: 18, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 19 0 R >>" },
    { number: 19, body: tinyPdfStream("", "") },
    { number: 20, body: "<< /Kids [21 0 R] >>" },
    { number: 21, body: "<< /Names [(Target) << /D [18 0 R /XYZ 12 34 null] >>] >>" },
    { number: 22, body: "<< /S /URI /URI (test) /Next [22 0 R << /S /Named /N /NextPage >>] >>" }
  ] });
}
