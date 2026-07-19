import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { MeshBVH } from "three-mesh-bvh";

export type GarmentKind = "top" | "bottom";

// Bone names vary wildly between rigs (Maya QuickRig "QuickRigCharacter2_LeftUpLeg",
// Tripo "L_Thigh" / "L_ThighTwist01", Mixamo "mixamorig:LeftUpLeg", …), so bones
// are classified into roles by keyword instead of matched by exact name.
type BoneRole =
  | "hips"
  | "upperleg"
  | "lowerleg"
  | "foot"
  | "toe"
  | "spine"
  | "shoulder"
  | "upperarm"
  | "forearm"
  | "hand"
  | "neck"
  | "head";

// Order matters: more specific patterns first ("toe" before "foot", "thigh"
// before the generic "leg", "forearm" before "arm").
const ROLE_PATTERNS: Array<[BoneRole, RegExp]> = [
  ["toe", /toe/],
  ["foot", /foot|ankle/],
  ["upperleg", /thigh|upleg/],
  ["lowerleg", /calf|shin|leg/],
  ["hips", /hip|pelvis/],
  ["spine", /spine|waist|chest/],
  ["shoulder", /clavicle|shoulder/],
  ["forearm", /forearm/],
  ["upperarm", /arm/],
  ["hand", /hand|thumb|index|middle|ring|pinky/],
  ["neck", /neck/],
  ["head", /head/],
];

export function boneRole(name: string): BoneRole | null {
  const n = name.toLowerCase();
  for (const [role, re] of ROLE_PATTERNS) if (re.test(n)) return role;
  return null;
}

// Which bones a garment is allowed to receive weight from. Hips appears in
// both so waistbands/hems follow the pelvis.
const BONE_SUBSETS: Record<GarmentKind, BoneRole[]> = {
  bottom: ["hips", "upperleg", "lowerleg", "foot", "toe"],
  top: ["hips", "spine", "shoulder", "upperarm", "forearm", "hand", "neck"],
};

// If a garment vertex ends up with no weight on allowed bones (e.g. a top
// vertex nearest to a leg), it is pinned entirely to this role's first bone.
const ANCHOR_ROLE: Record<GarmentKind, BoneRole> = { bottom: "hips", top: "spine" };

export function allowedBoneIndices(skeleton: THREE.Skeleton, kind: GarmentKind): Set<number> {
  const roles = new Set<BoneRole>(BONE_SUBSETS[kind]);
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
  const byRole = new Map<BoneRole, THREE.Vector3[]>();
  bodyRoot.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    const role = boneRole(o.name);
    if (!role) return;
    const pts = byRole.get(role) ?? [];
    pts.push(o.getWorldPosition(new THREE.Vector3()));
    byRole.set(role, pts);
  });

  // Average position across all bones of a role; first role with any bones wins.
  const at = (...roles: BoneRole[]) => {
    for (const role of roles) {
      const pts = byRole.get(role);
      if (pts?.length) {
        const sum = pts.reduce((s, p) => s.add(p), new THREE.Vector3());
        return sum.divideScalar(pts.length);
      }
    }
    throw new Error(`no ${roles.join("/")} bone found in body.glb`);
  };

  const hips = at("hips");
  if (kind === "bottom") {
    const foot = at("foot", "toe", "lowerleg");
    const height = Math.abs(hips.y - foot.y);
    return { center: new THREE.Vector3(hips.x, (hips.y + foot.y) / 2, hips.z), height };
  }
  const neck = at("neck", "head", "shoulder");
  const height = Math.abs(neck.y - hips.y) * 1.35; // sleeves/hem overshoot the torso
  return { center: new THREE.Vector3(hips.x, (hips.y + neck.y) / 2, hips.z), height };
}

/**
 * Transfer skin weights from the body to a garment geometry. The match runs
 * against the body's CURRENT pose (so the avatar can be posed to line up with
 * the garment — e.g. arms raised into sleeves), then each garment vertex is
 * un-posed back into bind space with the inverse of its own skinning matrix so
 * the result is a proper bind-pose skin.
 *
 * `geometry` must already be in the body mesh's local space, aligned with the
 * posed body as currently rendered.
 */
export function transferWeights(
  geometry: THREE.BufferGeometry,
  body: THREE.SkinnedMesh,
  kind: GarmentKind,
): void {
  const bodyGeo = body.geometry;
  body.updateMatrixWorld(true);

  // Body surface in its current pose, in mesh-local space (getVertexPosition
  // applies bind matrix + bone matrices per vertex for skinned meshes).
  const bodyCount = bodyGeo.attributes.position.count;
  const posed = new Float32Array(bodyCount * 3);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < bodyCount; i++) {
    body.getVertexPosition(i, tmp);
    posed[i * 3] = tmp.x;
    posed[i * 3 + 1] = tmp.y;
    posed[i * 3 + 2] = tmp.z;
  }
  const posedGeo = new THREE.BufferGeometry();
  posedGeo.setAttribute("position", new THREE.BufferAttribute(posed, 3));
  posedGeo.setIndex(bodyGeo.index ? bodyGeo.index.clone() : null);

  const bvh = new MeshBVH(posedGeo);
  const index = posedGeo.index;
  const srcIndex = bodyGeo.attributes.skinIndex as THREE.BufferAttribute;
  const srcWeight = bodyGeo.attributes.skinWeight as THREE.BufferAttribute;

  const allowed = allowedBoneIndices(body.skeleton, kind);
  if (allowed.size === 0) throw new Error(`no ${kind} bones recognized in body.glb skeleton`);
  const anchorIdx = body.skeleton.bones.findIndex((b) => boneRole(b.name) === ANCHOR_ROLE[kind]);
  if (anchorIdx < 0) throw new Error("anchor bone not found");

  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
  const count = pos.count;
  const outIndex = new Uint16Array(count * 4);
  const outWeight = new Float32Array(count * 4);

  const point = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const tri = new THREE.Triangle();
  const bary = new THREE.Vector3();
  const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  // Per-bone skinning matrices for the current pose (bind space → posed space).
  const bones = body.skeleton.bones;
  const boneInverses = body.skeleton.boneInverses;
  const boneMats = new Map<number, THREE.Matrix4>();
  const boneMat = (i: number) => {
    let m = boneMats.get(i);
    if (!m) {
      m = new THREE.Matrix4().multiplyMatrices(bones[i].matrixWorld, boneInverses[i]);
      boneMats.set(i, m);
    }
    return m;
  };
  const bindMatrix = body.bindMatrix;
  const bindMatrixInverse = body.bindMatrixInverse;
  const skinMat = new THREE.Matrix4();
  const acc16 = new Float64Array(16);
  const normalMat = new THREE.Matrix3();
  const n = new THREE.Vector3();

  for (let v = 0; v < count; v++) {
    point.fromBufferAttribute(pos, v);
    bvh.closestPointToPoint(point, target);

    const f = target.faceIndex * 3;
    const ids = [0, 1, 2].map((k) => (index ? index.getX(f + k) : f + k));
    ids.forEach((id, k) => corner[k].fromBufferAttribute(posedGeo.attributes.position, id));
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

    // Un-pose: invert this vertex's skinning matrix so the stored geometry is
    // in bind space and re-poses correctly once bound to the skeleton.
    acc16.fill(0);
    entries.forEach(([bone, w]) => {
      const e = boneMat(bone).elements;
      const wn = w / total;
      for (let k = 0; k < 16; k++) acc16[k] += e[k] * wn;
    });
    skinMat.fromArray(acc16);
    skinMat.premultiply(bindMatrixInverse).multiply(bindMatrix).invert();
    point.applyMatrix4(skinMat);
    pos.setXYZ(v, point.x, point.y, point.z);
    if (normal) {
      normalMat.getNormalMatrix(skinMat);
      n.fromBufferAttribute(normal, v).applyMatrix3(normalMat).normalize();
      normal.setXYZ(v, n.x, n.y, n.z);
    }
  }

  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(outIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(outWeight, 4));
}

/**
 * Symmetrically raise/lower the arms so the avatar can be posed to match a
 * garment's sleeve angle before binding. `angleDeg` is relative to the rest
 * pose; `restQuats` caches each arm bone's rest rotation across calls.
 */
export function poseArms(
  body: THREE.SkinnedMesh,
  restQuats: Map<THREE.Bone, THREE.Quaternion>,
  angleDeg: number,
): void {
  const rad = (angleDeg * Math.PI) / 180;
  const zAxis = new THREE.Vector3(0, 0, 1);
  const parentQ = new THREE.Quaternion();
  for (const bone of body.skeleton.bones) {
    if (boneRole(bone.name) !== "upperarm") continue;
    const lower = bone.name.toLowerCase();
    const left = lower.includes("left") || /(^|[^a-z])l[_\-.]/.test(lower);
    let restQ = restQuats.get(bone);
    if (!restQ) {
      restQ = bone.quaternion.clone();
      restQuats.set(bone, restQ);
    }
    bone.parent!.getWorldQuaternion(parentQ);
    const qWorld = new THREE.Quaternion().setFromAxisAngle(zAxis, (left ? 1 : -1) * rad);
    const qLocal = parentQ.clone().invert().multiply(qWorld).multiply(parentQ);
    bone.quaternion.copy(qLocal.multiply(restQ));
  }
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
