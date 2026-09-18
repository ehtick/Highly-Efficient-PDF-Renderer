/** Keep geometry/clip coverage while separating shape from paint opacity for knockout. */
export function pdfShapeCoverageGlsl(source: string): string {
  if (!source.includes("gl_Position") && !source.includes("outColor")) return source;
  if (source.includes("uPdfShapeOnly")) return source;
  const uniform = "\nuniform float uPdfShapeOnly;\n";
  source = source.replace(/precision highp float;/, `precision highp float;${uniform}`);
  if (source.includes("gl_Position")) {
    return source.replace(/alpha <= 0\.001/g, "(alpha <= 0.001 && uPdfShapeOnly < 0.5)")
      .replace(/instanceC\.w <= 0\.001/g, "(instanceC.w <= 0.001 && uPdfShapeOnly < 0.5)");
  }
  return source.replace(/\bvAlpha\b(?!\s*;)/g, "mix(vAlpha, 1.0, uPdfShapeOnly)")
    .replace(/\bvColorAlpha\b(?!\s*;)/g, "mix(vColorAlpha, 1.0, uPdfShapeOnly)")
    .replace(/\* uRasterOpacity/g, "* mix(uRasterOpacity, 1.0, uPdfShapeOnly)")
    .replace(/\* maskAlpha/g, "* mix(maskAlpha, 1.0, uPdfShapeOnly)");
}

/** Native WebGPU compiles a shape variant on demand; no per-pass uniform writes. */
export function pdfShapeCoverageWgsl(source: string): string {
  return source.replace(/\|\|\s*alpha <= 0\.001/g, "")
    .replace(/alpha <= 0\.001\s*\|\|/g, "")
    .replace(/\|\|\s*instanceC\.w <= 0\.001/g, "")
    .replace(/\binData\.alpha\b/g, "1.0")
    .replace(/\binData\.colorAlpha\b/g, "1.0")
    .replace(/\* maskAlpha/g, "")
    .replace(/\* uRaster\.(?:opacity|matrixB\.z)/g, "");
}
