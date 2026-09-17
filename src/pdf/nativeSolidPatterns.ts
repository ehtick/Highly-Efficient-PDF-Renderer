import { PdfCosParser, isPdfName, type PdfValue } from "./nativeCos";
import type { NativePdfExtGStateRegistry } from "./nativeExtGState";
import type { NativePdfPatternRegistry } from "./nativePatterns";
import { PdfError } from "./nativeTypes";

type SolidColor = readonly [number, number, number];

/**
 * A colored cell that fills its entire gapless tile is a solid paint, regardless
 * of its pattern matrix. Prove only this small, common subset; all other cells
 * keep their ordinary pattern rendering and fallback behavior.
 */
export async function resolveNativeSolidPattern(
  patterns: NativePdfPatternRegistry,
  extGStates: NativePdfExtGStateRegistry,
  patternIndex: number,
  signal: AbortSignal
): Promise<SolidColor | undefined> {
  const pattern = patterns.describe(patternIndex);
  if (pattern.kind !== "colored-tiling") return undefined;
  const [a, b, c, d] = pattern.matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) return undefined;
  const [x0, y0, x1, y1] = pattern.boundingBox;
  const close = (a: number, b: number): boolean =>
    Math.abs(a - b) <= Number.EPSILON * 8 * Math.max(1, Math.abs(a), Math.abs(b));
  if (!close(Math.abs(pattern.xStep), x1 - x0) ||
      !close(Math.abs(pattern.yStep), y1 - y0)) return undefined;
  if (pattern.encodedContentBytes > 65_536) return undefined;
  const bytes = await patterns.decodeTilingContent(patternIndex, signal);
  // An optional optimization must not become an unbounded second interpreter.
  if (bytes.length > 65_536) return undefined;
  const parser = new PdfCosParser(bytes, { maxDepth: 1, maxContainerEntries: 8 });
  const operands: PdfValue[] = [];
  let state: { color: SolidColor | null; blackInk: boolean; overprint: boolean } = {
    color: null, blackInk: false, overprint: false
  };
  const stack: typeof state[] = [];
  let rectangle: number[] | undefined;
  let painted: SolidColor | undefined;
  const colorResourcesValue = pattern.resources.get("ColorSpace");
  const colorResources = colorResourcesValue == null ? undefined :
    await patterns.document.resolveDictionary(colorResourcesValue, signal);
  const operators = ["q", "Q", "g", "rg", "k", "gs", "i", "re", "f", "F"];
  try {
    while (true) {
      signal.throwIfAborted();
      parser.skipWhitespaceAndComments();
      if (parser.remaining === 0) break;
      const operator = operators.find(value => parser.peekKeyword(value));
      if (!operator) {
        const byte = bytes[parser.position];
        // Containers and unknown operators are outside this proof. Do not parse
        // them with its deliberately small COS limits and reject a valid cell.
        if (byte !== 47 && byte !== 43 && byte !== 45 && byte !== 46 &&
            (byte < 48 || byte > 57)) return undefined;
        const value = parser.parseValue();
        if ((typeof value !== "number" || !Number.isFinite(value)) && !isPdfName(value)) return undefined;
        operands.push(value);
        if (operands.length > 4) return undefined;
        continue;
      }
      parser.consumeKeyword(operator);
      const numbers = (count: number): number[] | undefined =>
        operands.length === count && operands.every(value => typeof value === "number")
          ? operands as number[] : undefined;
      switch (operator) {
        case "q":
          if (operands.length || stack.length >= Math.min(64, patterns.document.limits.maxRecursionDepth)) return undefined;
          stack.push({ ...state });
          break;
        case "Q":
          if (operands.length || stack.length === 0) return undefined;
          state = stack.pop()!;
          break;
        case "g":
        case "rg":
        case "k": {
          const components = numbers(operator === "g" ? 1 : operator === "rg" ? 3 : 4);
          if (!components) return undefined;
          const colorIndex = await patterns.shadings.colors.add({ kind: "name",
            value: operator === "g" ? "DeviceGray" : operator === "rg" ? "DeviceRGB" : "DeviceCMYK"
          }, colorResources, signal);
          state.color = patterns.shadings.colors.convertToSrgb(colorIndex, components, signal);
          state.blackInk = patterns.shadings.colors.describe(colorIndex).kind === "DeviceCMYK" &&
            components[0] === 0 && components[1] === 0 && components[2] === 0 && components[3] === 1;
          break;
        }
        case "gs": {
          if (operands.length !== 1 || !isPdfName(operands[0])) return undefined;
          const gs = extGStates.describe(await extGStates.resolveExtGState(
            pattern.resources, operands[0].value, signal
          ));
          if ((gs.nonstrokingAlpha !== null && gs.nonstrokingAlpha !== 1) ||
              (gs.effectiveBlendMode !== null && gs.effectiveBlendMode !== "Normal") ||
              (gs.softMask !== null && gs.softMask.kind !== "none") || gs.alphaIsShape === true) return undefined;
          if (gs.nonstrokingOverprint !== null) state.overprint = gs.nonstrokingOverprint;
          break;
        }
        case "i":
          if (!numbers(1)) return undefined;
          break;
        case "re":
          if (rectangle || !numbers(4)) return undefined;
          rectangle = [...numbers(4)!];
          break;
        case "f":
        case "F": {
          if (operands.length || painted || !rectangle || !state.color) return undefined;
          // Screen output already treats overprinting black as ordinary black.
          // Do not extend that equivalence to other overprinting ink colors.
          if (state.overprint && !state.blackInk && state.color.some(value => value !== 0)) return undefined;
          const [x, y, width, height] = rectangle;
          const left = Math.min(x, x + width), right = Math.max(x, x + width);
          const bottom = Math.min(y, y + height), top = Math.max(y, y + height);
          if (!(left <= x0 || close(left, x0)) || !(right >= x1 || close(right, x1)) ||
              !(bottom <= y0 || close(bottom, y0)) || !(top >= y1 || close(top, y1))) return undefined;
          painted = state.color;
          rectangle = undefined;
          break;
        }
      }
      operands.length = 0;
    }
    return operands.length === 0 && stack.length === 0 && !rectangle ? painted : undefined;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PdfError && error.code === "resource-limit") throw error;
    // Unsupported/malformed content must still reach the normal compiler.
    return undefined;
  }
}
