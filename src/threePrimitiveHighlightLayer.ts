import * as THREE from "three";
import { NodeMaterial, TSL } from "three/webgpu";
import { type PrimitiveHighlightSet, PRIMITIVE_SELECTION_COLOR, PRIMITIVE_HOVER_COLOR } from "./primitiveAppearance";
import { PRIMITIVE_HIGHLIGHT_VERTEX_GLSL, PRIMITIVE_HIGHLIGHT_FRAGMENT_GLSL,
  PRIMITIVE_HIGHLIGHT_COVERAGE_WGSL, PRIMITIVE_HIGHLIGHT_POSITION_WGSL,
  PRIMITIVE_HIGHLIGHT_LINE_OFFSET_WGSL, PRIMITIVE_HIGHLIGHT_QUADRATIC_OFFSET_WGSL } from "./primitiveHighlightShaders";
import { normalizeThreeRawShaderSource } from "./threeRawShaderColorSpace";
import { configureStraightAlphaBlending } from "./threeMaterialBlending";
import { createThreeWebGpuOutputFragmentFns, type ThreeColorCompositing } from "./threeWebGpuColorSpace";
import { VECTOR_CLIP_WGSL } from "./vectorClipShaders";
import { MAX_VECTOR_CLIP_DEPTH, packVectorClips } from "./vectorClips";
import { HEPR_THREE_LAYER_ORDER_TEXT_SELECTION } from "./threeLayerOrder";

const lineFn = TSL.wgslFn(PRIMITIVE_HIGHLIGHT_LINE_OFFSET_WGSL);
const quadraticFn = TSL.wgslFn(PRIMITIVE_HIGHLIGHT_QUADRATIC_OFFSET_WGSL, [lineFn] as never);
const coverageFn = TSL.wgslFn(PRIMITIVE_HIGHLIGHT_COVERAGE_WGSL, [lineFn, quadraticFn] as never);
const positionFn = TSL.wgslFn(PRIMITIVE_HIGHLIGHT_POSITION_WGSL);
const clipFn = TSL.wgslFn(VECTOR_CLIP_WGSL.replace(/depth < \d+/, `depth < ${MAX_VECTOR_CLIP_DEPTH + 2}`));
const fragmentFns = createThreeWebGpuOutputFragmentFns(`
fn heprThreePrimitiveHighlight(point:vec2<f32>,a:vec4<f32>,b:vec4<f32>,index:f32,
  pixelRatio:f32,selectionCount:f32,clipTexture:texture_2d<f32>) -> vec4<f32> {
  let alpha=heprPrimitiveHighlightCoverage(point,a,b,pixelRatio)*heprVectorClip(point,b.w,clipTexture);
  if (alpha<=0.001) { discard; }
  let color=select(vec3<f32>(${PRIMITIVE_HOVER_COLOR.join(",")}),
    vec3<f32>(${PRIMITIVE_SELECTION_COLOR.join(",")}),index<selectionCount);
  return vec4<f32>(heprThreeOutputColor(color),alpha);
}`, [coverageFn, clipFn]);

function nodeCall(fn: unknown, args: Record<string, unknown>): never {
  return (fn as (args: Record<string, unknown>) => unknown)(args) as never;
}

/** Compact analytical traces, drawn after PDF content in both Three backends. */
export class ThreePrimitiveHighlightLayer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  private readonly matrix = new THREE.Matrix4();
  private readonly units = TSL.uniform(1);
  private readonly pixelRatio = TSL.uniform(1);
  private readonly selectionCount = TSL.uniform(0);
  private readonly clips = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  private segmentBuffer: THREE.InstancedInterleavedBuffer | null = null;
  private capacity = 0;

  constructor(backend: "webgl" | "webgpu", colorCompositing: ThreeColorCompositing) {
    this.clips.minFilter = this.clips.magFilter = THREE.NearestFilter;
    this.clips.generateMipmaps = false;
    let material: THREE.Material;
    if (backend === "webgl") {
      material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: normalizeThreeRawShaderSource(PRIMITIVE_HIGHLIGHT_VERTEX_GLSL),
        fragmentShader: normalizeThreeRawShaderSource(PRIMITIVE_HIGHLIGHT_FRAGMENT_GLSL),
        uniforms: {
          uLocalToClip: { value: this.matrix }, uLocalUnitsPerPixel: this.units,
          uPixelRatio: this.pixelRatio, uSelectionCount: this.selectionCount,
          uVectorClipTex: { value: this.clips }
        },
        depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false
      });
    } else {
      const nodeMaterial = new NodeMaterial();
      const a = TSL.varying(TSL.attribute("aSegmentA", "vec4"));
      const b = TSL.varying(TSL.attribute("aSegmentB", "vec4"));
      const point = TSL.varying(nodeCall(positionFn, {
        corner: TSL.attribute("aCorner", "vec2"), a, b,
        localUnitsPerPixel: this.units, pixelRatio: this.pixelRatio
      }));
      nodeMaterial.vertexNode = TSL.mul(TSL.uniform(this.matrix), TSL.vec4(point as never, 0, 1));
      nodeMaterial.fragmentNode = nodeCall(fragmentFns[colorCompositing], {
        point, a, b, index: TSL.varying(TSL.attribute("aHighlightIndex", "float")),
        pixelRatio: this.pixelRatio, selectionCount: this.selectionCount,
        clipTexture: TSL.textureLoad(this.clips)
      });
      nodeMaterial.depthTest = nodeMaterial.depthWrite = false;
      nodeMaterial.side = THREE.DoubleSide;
      nodeMaterial.toneMapped = false;
      material = nodeMaterial;
    }
    configureStraightAlphaBlending(material);
    // Fallback page textures use renderOrder 0, unlike the negative vector
    // layer orders. Present traces in Three's overlay/transparent queue so
    // both the opaque fallback page and vector layers are already drawn.
    material.transparent = true;
    material.forceSinglePass = true;
    this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = HEPR_THREE_LAYER_ORDER_TEXT_SELECTION + 4;
    this.mesh.name = "hepr-primitive-highlights";
  }

  setHighlights(highlights: PrimitiveHighlightSet): void {
    if (!this.segmentBuffer || highlights.count > this.capacity) {
      this.capacity = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, highlights.count))));
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute("aCorner", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
      geometry.setIndex([0, 1, 2, 2, 1, 3]);
      this.segmentBuffer = new THREE.InstancedInterleavedBuffer(new Float32Array(this.capacity * 8), 8);
      this.segmentBuffer.setUsage(THREE.StreamDrawUsage);
      geometry.setAttribute("aSegmentA", new THREE.InterleavedBufferAttribute(this.segmentBuffer, 4, 0));
      geometry.setAttribute("aSegmentB", new THREE.InterleavedBufferAttribute(this.segmentBuffer, 4, 4));
      const ids = Float32Array.from({ length: this.capacity }, (_, index) => index);
      geometry.setAttribute("aHighlightIndex", new THREE.InstancedBufferAttribute(ids, 1));
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
    }
    this.segmentBuffer.array.set(highlights.segments);
    this.segmentBuffer.clearUpdateRanges();
    this.segmentBuffer.addUpdateRange(0, highlights.count * 8);
    this.segmentBuffer.needsUpdate = true;
    this.mesh.geometry.instanceCount = highlights.count;
    this.selectionCount.value = highlights.selectionCount;
    const packed = packVectorClips(highlights.clipPaths);
    const width = Math.min(4096, Math.max(1, Math.ceil(Math.sqrt(packed.length / 4))));
    const height = Math.max(1, Math.ceil(packed.length / 4 / width));
    if (height > 4096) throw new RangeError("Primitive highlight clip texture exceeds material capacity.");
    const resized = this.clips.image.width !== width || this.clips.image.height !== height;
    const data = resized ? new Float32Array(width * height * 4) : this.clips.image.data as Float32Array;
    data.set(packed);
    if (resized) {
      this.clips.dispose();
      this.clips.image = { data, width, height };
    }
    this.clips.needsUpdate = true;
  }

  updateFrame(matrix: THREE.Matrix4, localUnitsPerPixel: number, pixelRatio: number): void {
    this.matrix.copy(matrix);
    this.units.value = Math.max(1e-6, localUnitsPerPixel);
    this.pixelRatio.value = Math.max(0.1, pixelRatio);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.clips.dispose();
  }
}
