import type { PdfBlendMode } from "./heprDocumentData";

export type PdfRgb = readonly [number, number, number];
export type PdfRgba = readonly [number, number, number, number];
const clamp = (x: number): number => Math.max(0, Math.min(1, x));
const lum = (c: PdfRgb): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const sat = (c: PdfRgb): number => Math.max(...c) - Math.min(...c);

function setLum(c: PdfRgb, value: number): [number, number, number] {
  const d = value - lum(c);
  let result = c.map(x => x + d);
  const l = lum(result as [number, number, number]);
  const low = Math.min(...result), high = Math.max(...result);
  if (low < 0) result = result.map(x => l + (x - l) * l / (l - low));
  if (high > 1) result = result.map(x => l + (x - l) * (1 - l) / (high - l));
  return result as [number, number, number];
}
function setSat(c: PdfRgb, value: number): [number, number, number] {
  const low = Math.min(...c), range = sat(c);
  return c.map(x => range > 0 ? (x - low) * value / range : 0) as [number, number, number];
}

/** PDF/W3C blend functions on unassociated components in the group's blend space. */
export function pdfBlend(backdrop: PdfRgb, source: PdfRgb, mode: PdfBlendMode): [number, number, number] {
  if (mode === "Hue") return setLum(setSat(source, sat(backdrop)), lum(backdrop));
  if (mode === "Saturation") return setLum(setSat(backdrop, sat(source)), lum(backdrop));
  if (mode === "Color") return setLum(source, lum(backdrop));
  if (mode === "Luminosity") return setLum(backdrop, lum(source));
  return backdrop.map((b, i) => {
    const s = source[i];
    switch (mode) {
      case "Normal": return s;
      case "Multiply": return b * s;
      case "Screen": return b + s - b * s;
      case "Overlay": return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      case "Darken": return Math.min(b, s);
      case "Lighten": return Math.max(b, s);
      case "ColorDodge": return b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s));
      case "ColorBurn": return b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
      case "HardLight": return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      case "SoftLight": {
        const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
        return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
      }
      case "Difference": return Math.abs(b - s);
      case "Exclusion": return b + s - 2 * b * s;
    }
  }) as [number, number, number];
}

/** Source-over, including backdrop alpha, on premultiplied RGBA. */
export function compositePdfPixel(backdrop: PdfRgba, source: PdfRgba, mode: PdfBlendMode = "Normal"): [number, number, number, number] {
  const ab = clamp(backdrop[3]), as = clamp(source[3]);
  const cb = backdrop.slice(0, 3).map(x => ab > 0 ? x / ab : 0) as [number, number, number];
  const cs = source.slice(0, 3).map(x => as > 0 ? x / as : 0) as [number, number, number];
  const blend = pdfBlend(cb, cs, mode);
  return [0, 1, 2].map(i => (1 - as) * backdrop[i] + (1 - ab) * source[i] + as * ab * blend[i])
    .concat(as + ab * (1 - as)) as [number, number, number, number];
}

/** Removes a non-isolated group's initial backdrop before applying group opacity once. */
export function extractPdfGroupPixel(result: PdfRgba, initial: PdfRgba, groupAlpha: number, opacity = 1): [number, number, number, number] {
  const alpha = clamp(groupAlpha);
  return [0, 1, 2].map(i => clamp(result[i] - initial[i] * (1 - alpha)) * opacity)
    .concat(alpha * opacity) as [number, number, number, number];
}

/** A knockout replaces the previous sibling's shape, independently of paint opacity. */
export function knockoutPdfPixel(previous: PdfRgba, initial: PdfRgba, child: PdfRgba, shape: number): [number, number, number, number] {
  return child.map((x, i) => clamp(x + (1 - shape) * (previous[i] - initial[i]))) as [number, number, number, number];
}

export function pdfMaskValue(pixel: PdfRgba, subtype: "Alpha" | "Luminosity", backdrop: PdfRgb = [0, 0, 0], transfer?: Float32Array): number {
  let value = subtype === "Alpha" ? pixel[3] : lum([pixel[0] + (1 - pixel[3]) * backdrop[0],
    pixel[1] + (1 - pixel[3]) * backdrop[1], pixel[2] + (1 - pixel[3]) * backdrop[2]]);
  value = clamp(value);
  if (transfer?.length) {
    const at = value * (transfer.length - 1), first = Math.floor(at), t = at - first;
    value = transfer[first] * (1 - t) + transfer[Math.min(first + 1, transfer.length - 1)] * t;
  }
  return clamp(value);
}
