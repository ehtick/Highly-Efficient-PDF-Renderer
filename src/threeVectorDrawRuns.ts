import { createThreeMultiplyMaterial } from "./threeVectorMultiply";
import { createThreeVectorClipMaterial } from "./threeVectorClips";
import * as THREE from "three";
import type { VectorDrawRun, VectorScene } from "./pdfVectorExtractor";
import { HEPR_THREE_LAYER_ORDER_RASTER, HEPR_THREE_LAYER_ORDER_TEXT } from "./threeLayerOrder";

export function vectorDrawRunRenderOrder(index: number, count: number): number {
  return HEPR_THREE_LAYER_ORDER_RASTER +
    (HEPR_THREE_LAYER_ORDER_TEXT - HEPR_THREE_LAYER_ORDER_RASTER) * ((index + 1) / (count + 1));
}

/** Share material/textures, splitting only the instance IDs at source paint boundaries. */
export class ThreeVectorDrawRuns {
  private readonly entries: { mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
    first: number; count: number; ids: THREE.InstancedBufferAttribute }[] = [];
  private readonly clipMaterials = new Map<string, THREE.Material>();
  private readonly visibleIds: Uint8Array;
  private sourceCount: number;
  private sourceVersion = -1;
  private enabled = true;
  private readonly parent: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  private readonly attribute: string;

  static create(scene: VectorScene, kind: VectorDrawRun["kind"],
    parent: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>, attribute: string): ThreeVectorDrawRuns | null {
    return scene.drawRuns ? new ThreeVectorDrawRuns(scene, kind, parent, attribute) : null;
  }

  private constructor(scene: VectorScene, kind: VectorDrawRun["kind"],
    parent: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>, attribute: string) {
    this.parent = parent;
    this.attribute = attribute;
    const source = parent.geometry.getAttribute(attribute);
    this.visibleIds = new Uint8Array(source.count);
    this.sourceCount = parent.geometry.instanceCount;
    scene.drawRuns!.forEach((run, index) => {
      if (run.kind !== kind) return;
      const create = (first: number, count: number, order: number, pass?: 0 | 1): void => {
        const geometry = new THREE.InstancedBufferGeometry();
        for (const [name, value] of Object.entries(parent.geometry.attributes)) {
          if (name !== attribute) geometry.setAttribute(name, value);
        }
        geometry.setIndex(parent.geometry.index);
        const ids = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
        ids.setUsage(THREE.StreamDrawUsage);
        geometry.setAttribute(attribute, ids);
        geometry.instanceCount = count;
        const key = `${run.clipIndex ?? -1}:${pass ?? "normal"}`;
        let material = this.clipMaterials.get(key);
        if (!material) {
          material = createThreeVectorClipMaterial(parent.material, run.clipIndex);
          if (pass !== undefined) {
            const clipped = material;
            material = createThreeMultiplyMaterial(clipped, pass);
            if (clipped !== parent.material) clipped.dispose();
          }
          if (material !== parent.material) this.clipMaterials.set(key, material);
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = vectorDrawRunRenderOrder(order, scene.drawRuns!.length);
        parent.add(mesh);
        this.entries.push({ mesh, first, count, ids });
      };
      if (run.blendMode === "Multiply") {
        for (let item = 0; item < run.count; item++) {
          create(run.first + item, 1, index + item / run.count, 0);
          create(run.first + item, 1, index + (item + 0.5) / run.count, 1);
        }
      } else create(run.first, run.count, index);
    });
    this.finishUpdate();
  }

  beginUpdate(): void {
    this.parent.geometry.instanceCount = this.sourceCount;
  }

  finishUpdate(): void {
    const source = this.parent.geometry.getAttribute(this.attribute) as THREE.InstancedBufferAttribute;
    const count = this.parent.geometry.instanceCount;
    this.parent.geometry.instanceCount = 0;
    if (source.version === this.sourceVersion && count === this.sourceCount) return;
    this.sourceVersion = source.version;
    this.sourceCount = count;
    this.visibleIds.fill(0);
    for (let i = 0; i < count; i++) this.visibleIds[source.getX(i)] = 1;
    for (const entry of this.entries) {
      let visible = 0;
      for (let id = entry.first; id < entry.first + entry.count; id++) {
        if (this.visibleIds[id]) entry.ids.setX(visible++, id);
      }
      entry.mesh.geometry.instanceCount = visible;
      entry.ids.clearUpdateRanges();
      if (visible > 0) entry.ids.addUpdateRange(0, visible);
      entry.ids.needsUpdate = true;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const entry of this.entries) entry.mesh.visible = enabled;
  }

  getRenderedCount(): number { return this.enabled ? this.sourceCount : 0; }

  dispose(): void {
    for (const material of this.clipMaterials.values()) material.dispose();
    this.clipMaterials.clear();
    for (const entry of this.entries) {
      this.parent.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
  }
}
