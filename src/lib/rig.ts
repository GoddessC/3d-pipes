import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { MeshBVH } from "three-mesh-bvh";

export type GarmentKind = "top" | "bottom";

// Deforming bones in body.glb are prefixed (Maya QuickRig export); the
// unprefixed duplicates under the _Guides group carry no skin weights.
const BONE_PREFIX = "QuickRigCharacter2_";

// Which bones a garment is allowed to receive weight from. Hips appears in
// both so waistbands/hems follow the pelvis.
const BONE_SUBSETS: Record<GarmentKind, string[]> = {
  bottom: ["Hips", "UpLeg", "Leg", "Foot", "ToeBase"],
  top: ["Hips", "Spine", "Spine1", "Spine2", "Shoulder", "Arm", "ForeArm", "Hand", "Neck"],
};

// If a garment vertex ends up with no weight on allowed bones (e.g. a top
// vertex nearest to a leg), it is pinned entirely to this bone.
const ANCHOR_BONE: Record<GarmentKind, string> = { bottom: "Hips", top: "Spine1" };

/** Strip the rig prefix and Left/Right so bones can be matched by role. */
function boneRole(name: string): string | null {
  if (!name.startsWith(BONE_PREFIX)) return null;
  return name.slice(BONE_PREFIX.length).replace(/^(Left|Right)/, "");
}

export function allowedBoneIndices(skeleton: THREE.Skeleton, kind: GarmentKind): Set<number> {
  const roles = new Set(BONE_SUBSETS[kind]);
  const allowed = new Set<number>();
  skeleton.bones.forEach((bone, i) => {
    const role = boneRole(bone.name);
    if (role && roles.has(role)) allowed.add(i);
  });
  return allowed;
}

export async function loadGltf(url: string): Promise<GLTF> {
  return new GLTFLoader().loadAsync(url);
}

/** The main skinned body mesh (largest vertex count wins; skips the head). */
export function findBodyMesh(root: THREE.Object3D): THREE.SkinnedMesh {
  let best: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) {
      if (!best || o.geometry.attributes.position.count > best.geometry.attributes.position.count) {
        best = o;
      }
    }
  });
  if (!best) throw new Error("body.glb contains no skinned mesh");
  return best;
}

export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  return meshes;
}

export interface FitFrame {
  /** World-space center of the region the garment should cover. */
  center: THREE.Vector3;
  /** World-space height of that region. */
  height: number;
}

/** Region of the body a garment kind should cover, from bone world positions. */
export function fitFrame(bodyRoot: THREE.Object3D, kind: GarmentKind): FitFrame {
  bodyRoot.updateMatrixWorld(true);
  const at = (name: string) => {
    const node = bodyRoot.getObjectByName(BONE_PREFIX + name);
    if (!node) throw new Error(`bone ${name} not found in body.glb`);
    return node.getWorldPosition(new THREE.Vector3());
  };
  const hips = at("Hips");
  if (kind === "bottom") {
    const foot = at("LeftFoot");
    const height = Math.abs(hips.y - foot.y);
    return { center: new THREE.Vector3(hips.x, (hips.y + foot.y) / 2, hips.z), height };
  }
  const neck = at("Neck");
  const height = Math.abs(neck.y - hips.y) * 1.35; // sleeves/hem overshoot the torso
  return { center: new THREE.Vector3(hips.x, (hips.y + neck.y) / 2, hips.z), height };
}

/**
 * Transfer skin weights from the body to a garment geometry. For each garment
 * vertex, the closest point on the body surface is found and the bind weights
 * of that triangle are interpolated barycentrically, then restricted to the
 * allowed bone subset and renormalized.
 *
 * `geometry` must already be in the body mesh's local (bind) space.
 */
export function transferWeights(
  geometry: THREE.BufferGeometry,
  body: THREE.SkinnedMesh,
  kind: GarmentKind,
): void {
  const bodyGeo = body.geometry;
  const bvh = new MeshBVH(bodyGeo);
  const index = bodyGeo.index;
  const srcIndex = bodyGeo.attributes.skinIndex as THREE.BufferAttribute;
  const srcWeight = bodyGeo.attributes.skinWeight as THREE.BufferAttribute;

  const allowed = allowedBoneIndices(body.skeleton, kind);
  const anchorIdx = body.skeleton.bones.findIndex((b) => b.name === BONE_PREFIX + ANCHOR_BONE[kind]);
  if (anchorIdx < 0) throw new Error("anchor bone not found");

  const pos = geometry.attributes.position;
  const count = pos.count;
  const outIndex = new Uint16Array(count * 4);
  const outWeight = new Float32Array(count * 4);

  const point = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const tri = new THREE.Triangle();
  const bary = new THREE.Vector3();
  const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  for (let v = 0; v < count; v++) {
    point.fromBufferAttribute(pos, v);
    bvh.closestPointToPoint(point, target);

    const f = target.faceIndex * 3;
    const ids = [0, 1, 2].map((k) => (index ? index.getX(f + k) : f + k));
    ids.forEach((id, k) => corner[k].fromBufferAttribute(bodyGeo.attributes.position, id));
    tri.set(corner[0], corner[1], corner[2]);
    tri.getBarycoord(target.point, bary);
    const baryW = [bary.x, bary.y, bary.z];

    // Accumulate per-bone weight across the triangle's corners.
    const acc = new Map<number, number>();
    ids.forEach((id, k) => {
      for (let c = 0; c < 4; c++) {
        const bone = srcIndex.getComponent(id, c);
        const w = srcWeight.getComponent(id, c) * baryW[k];
        if (w > 0 && allowed.has(bone)) acc.set(bone, (acc.get(bone) ?? 0) + w);
      }
    });

    let entries = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let total = entries.reduce((s, [, w]) => s + w, 0);
    if (total < 1e-6) {
      entries = [[anchorIdx, 1]];
      total = 1;
    }
    entries.forEach(([bone, w], c) => {
      outIndex[v * 4 + c] = bone;
      outWeight[v * 4 + c] = w / total;
    });
  }

  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(outIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(outWeight, 4));
}

/**
 * Bake a fitted garment mesh into a SkinnedMesh bound to the body skeleton.
 * The mesh's current world transform is baked into the geometry first.
 */
export function bindGarment(
  mesh: THREE.Mesh,
  body: THREE.SkinnedMesh,
  kind: GarmentKind,
): THREE.SkinnedMesh {
  mesh.updateMatrixWorld(true);
  body.updateMatrixWorld(true);

  const geometry = mesh.geometry.clone();
  const toBodyLocal = new THREE.Matrix4()
    .copy(body.matrixWorld)
    .invert()
    .multiply(mesh.matrixWorld);
  geometry.applyMatrix4(toBodyLocal);

  transferWeights(geometry, body, kind);

  const skinned = new THREE.SkinnedMesh(geometry, mesh.material);
  skinned.name = `${mesh.name || "garment"}_rigged`;
  skinned.frustumCulled = false;
  skinned.position.copy(body.position);
  skinned.quaternion.copy(body.quaternion);
  skinned.scale.copy(body.scale);
  body.parent!.add(skinned);
  skinned.bind(body.skeleton, body.bindMatrix);
  return skinned;
}

export async function exportGlb(
  root: THREE.Object3D,
  animations: THREE.AnimationClip[],
): Promise<Blob> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true, animations });
  return new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
}
