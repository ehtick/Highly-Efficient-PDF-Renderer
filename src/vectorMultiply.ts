/** Convert straight-alpha paint to premultiplied output only while blending Multiply. */
export function multiplyFragmentGlsl(source: string, uniform = false): string {
  return source.replace(/void\s+main\s*\(\s*\)/, "void heprMultiplyPaint()") + `
${uniform ? "uniform bool uHeprMultiply;" : ""}
void main() {
  heprMultiplyPaint();
  ${uniform ? "if (uHeprMultiply) " : ""}outColor.rgb *= outColor.a;
}
`;
}

export function multiplyFragmentWgsl(source: string): string {
  const signature = /@fragment\s+fn fsMain\(inData\s*:\s*(\w+)\)\s*->\s*@location\(0\)\s*vec4f/;
  const match = source.match(signature);
  if (!match) throw new Error("Multiply paint shader has no supported fragment entry point.");
  return source.replace(signature, `fn heprMultiplyPaint(inData: ${match[1]}) -> vec4f`) + `
@fragment
fn fsMain(inData: ${match[1]}) -> @location(0) vec4f {
  let color = heprMultiplyPaint(inData);
  return vec4f(color.rgb * color.a, color.a);
}
`;
}

/**
 * Two ordered passes implement PDF Multiply even over transparent targets.
 * First: Cs*As*Cd + Cd*(1-As), preserving Ad.
 * Second: add Cs*As*(1-Ad), then accumulate As + Ad*(1-As).
 * Pair the passes per primitive, before painting the next primitive.
 */
export function multiplyBlendState(pass: 0 | 1): {
  color: { srcFactor: string; dstFactor: string; operation: string };
  alpha: { srcFactor: string; dstFactor: string; operation: string };
} {
  return {
    color: { srcFactor: pass === 0 ? "dst" : "one-minus-dst-alpha",
      dstFactor: pass === 0 ? "one-minus-src-alpha" : "one", operation: "add" },
    alpha: { srcFactor: pass === 0 ? "zero" : "one",
      dstFactor: pass === 0 ? "one" : "one-minus-src-alpha", operation: "add" }
  };
}
