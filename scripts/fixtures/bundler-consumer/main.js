import * as hepr from "@soadzoor/hepr/bundler";

// Retain every public export so the build checks optional paths as well.
window.hepr = hepr;
document.querySelector("#file").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.querySelector("#status");
  status.textContent = "Loading…";
  try {
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const pdf = await hepr.pdfObjectGenerator(file, { pdfFastPath: "off" });
      try {
        if (pdf.sceneData.pageCount < 1) throw new Error("No PDF pages loaded.");
        status.textContent = `Loaded ${pdf.sceneData.pageCount} page(s), pass ${iteration + 1}/2.`;
      } finally { pdf.dispose(); }
    }
  } catch (error) {
    status.textContent = error.stack ?? String(error);
    console.error(error);
  }
});
