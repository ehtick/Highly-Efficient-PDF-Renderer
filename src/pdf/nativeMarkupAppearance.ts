import { ANNOTATION_LIMITS } from "../annotationData";
import { isPdfDictionary, isPdfName, type PdfDictionary, type PdfValue } from "./nativeCos";
import type { NativePdfDocument } from "./nativeDocument";
import type { NativePdfAnnotationAppearance } from "./nativeForms";
import { PdfError, throwIfAborted } from "./nativeTypes";

/** Small, bounded vector Forms for markup without a supplied normal appearance. */
export async function buildNativeMarkupAppearance(document: NativePdfDocument,
  annotation: NativePdfAnnotationAppearance, signal?: AbortSignal): Promise<{
    content: Uint8Array; resources: PdfDictionary; approximation?: string;
  }> {
  const d = annotation.dictionary;
  const [left, bottom, right, top] = annotation.rectangle;
  const width = right - left, height = top - bottom;
  const resolve = (value: PdfValue | undefined) => document.resolveValue(value, signal);
  const invalid = (message: string): never => { throw new PdfError("invalid-object", message, {
    pageIndex: annotation.pageIndex, details: { annotationIndex: annotation.annotationIndex }
  }); };
  let coordinates = 0;
  const numbers = async (raw: PdfValue | undefined, multiple: number, minimum = multiple): Promise<number[]> => {
    const value = await resolve(raw);
    if (!Array.isArray(value) || value.length < minimum || value.length % multiple) return invalid("Invalid markup coordinate array.");
    coordinates += value.length;
    if (coordinates > Math.min(ANNOTATION_LIMITS.numbers, document.limits.maxPathCoordinatesPerPage)) {
      throw new PdfError("resource-limit", "Markup coordinates exceed the page limit.", { pageIndex: annotation.pageIndex });
    }
    const result: number[] = [];
    for (const rawNumber of value) {
      throwIfAborted(signal);
      const n = await resolve(rawNumber);
      if (typeof n !== "number" || !Number.isFinite(n)) return invalid("Markup coordinates must be finite.");
      if (Math.abs(n) >= 1e20) throw new PdfError("resource-limit", "Markup coordinate exceeds the supported range.");
      result.push(n);
    }
    return result;
  };
  const subtype = annotation.subtype;
  const defaults = subtype === "Highlight" || subtype === "Text" ? [1, 1, 0] : [0];
  const colorValue = await resolve(d.get("C"));
  const color = colorValue == null ? defaults : await numbers(colorValue, 1, 0);
  if (![0, 1, 3, 4].includes(color.length) || color.some(n => n < 0 || n > 1)) return invalid("Invalid markup color.");
  const opacityValue = await resolve(d.get("CA"));
  const opacity = opacityValue == null ? 1 : opacityValue;
  if (typeof opacity !== "number" || opacity < 0 || opacity > 1 || !Number.isFinite(opacity)) return invalid("Invalid markup opacity.");
  const resources: PdfDictionary = new Map();
  const gs: PdfDictionary = new Map<string, PdfValue>([
    ["CA", opacity], ["ca", opacity], ["BM", { kind: "name", value: subtype === "Highlight" ? "Multiply" : "Normal" }]
  ]);
  resources.set("ExtGState", new Map([["AnnotGS", gs]]));
  const n = (value: number): string => String(Math.round(value * 1e6) / 1e6);
  const point = (x: number, y: number): string => `${n(x - left)} ${n(y - bottom)}`;
  const paint = (stroke: boolean): string => `${color.map(n).join(" ")} ${color.length === 1 ? (stroke ? "G" : "g") :
    color.length === 3 ? (stroke ? "RG" : "rg") : (stroke ? "K" : "k")}`;
  const lines = ["q", `0 0 ${n(width)} ${n(height)} re W n`, "/AnnotGS gs"];
  let approximation: string | undefined;
  if (color.length === 0 || opacity === 0) return { content: new TextEncoder().encode("q Q"), resources };
  const bs = await resolve(d.get("BS"));
  const border = await resolve(d.get("Border"));
  const rawStrokeWidth = isPdfDictionary(bs) ? await resolve(bs.get("W")) : Array.isArray(border) ? await resolve(border[2]) : undefined;
  const strokeWidth = rawStrokeWidth == null ? 1 : rawStrokeWidth;
  if (typeof strokeWidth !== "number" || strokeWidth < 0 || !Number.isFinite(strokeWidth)) return invalid("Invalid markup stroke width.");
  lines.push(paint(false), paint(true), `${n(strokeWidth)} w`, "1 J 1 j");
  const dashValue = isPdfDictionary(bs) ? bs.get("D") : Array.isArray(border) ? border[3] : undefined;
  if (dashValue != null && (!isPdfDictionary(bs) || isPdfName(await resolve(bs.get("S")), "D"))) {
    const dash = await numbers(dashValue, 1, 0);
    if (dash.some(v => v < 0) || (dash.length && !dash.some(v => v > 0))) return invalid("Invalid markup dash array.");
    lines.push(`[${dash.map(n).join(" ")}] 0 d`);
  }
  if (subtype === "Highlight" || subtype === "Underline") {
    const quads = await numbers(d.get("QuadPoints"), 8);
    for (let i = 0; i < quads.length; i += 8) {
      throwIfAborted(signal);
      const points = Array.from({ length: 4 }, (_, j) => [quads[i + j * 2], quads[i + j * 2 + 1]]);
      if (subtype === "Highlight") {
        // Both the specification's cyclic order and the common Z order occur in real files.
        const cx = points.reduce((sum, p) => sum + p[0], 0) / 4, cy = points.reduce((sum, p) => sum + p[1], 0) / 4;
        points.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
        lines.push(points.map((p, j) => `${point(p[0], p[1])} ${j ? "l" : "m"}`).join(" ") + " h f");
      } else {
        const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        const zOrder = cross(points[0], points[1], points[2]) * cross(points[1], points[2], points[3]) < 0;
        const a = points[zOrder ? 2 : 0], b = points[zOrder ? 3 : 1];
        lines.push(`${point(a[0], a[1])} m ${point(b[0], b[1])} l S`);
      }
    }
  } else if (subtype === "Ink") {
    const ink = await resolve(d.get("InkList"));
    if (!Array.isArray(ink)) return invalid("Missing ink paths.");
    if (ink.length > document.limits.maxPathsPerPage) throw new PdfError("resource-limit", "Too many ink paths.");
    for (const pathValue of ink) {
      const path = await numbers(pathValue, 2);
      lines.push(path.map((v, i) => i % 2 ? "" : `${point(v, path[i + 1])} ${i ? "l" : "m"}`).filter(Boolean).join(" ") +
        (path.length === 2 ? ` ${point(path[0], path[1])} l S` : " S"));
    }
  } else if (subtype === "Text") {
    // A folded note, deliberately containing no comment text or font resources.
    lines.push(`${n(width)} 0 0 ${n(height)} 0 0 cm`, "0.05 w", "0.1 0.1 m 0.9 0.1 l 0.9 0.65 l 0.65 0.9 l 0.1 0.9 l h f",
      "0 G", "0.1 0.1 m 0.9 0.1 l 0.9 0.65 l 0.65 0.9 l 0.1 0.9 l h S",
      "0.65 0.9 m 0.65 0.65 l 0.9 0.65 l S", "0.25 0.5 m 0.7 0.5 l 0.25 0.35 m 0.6 0.35 l S");
  } else {
    approximation = `/${subtype} has no normal appearance; a rectangular outline marks its bounds.`;
    const inset = Math.min(0.5, width / 4, height / 4);
    lines.push(`${n(inset * 2)} w`, `${n(inset)} ${n(inset)} ${n(width - inset * 2)} ${n(height - inset * 2)} re S`);
  }
  lines.push("Q");
  return { content: new TextEncoder().encode(lines.join("\n")), resources, approximation };
}
