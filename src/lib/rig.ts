import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { MeshBVH } from "three-mesh-bvh";

export type GarmentKind = "top" | "bottom" | "head" | "face";

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
  head: ["head", "neck"],
  // Eyes/brows/pupils must ride the skull rigidly — any neck blend smears them.
  face: ["head"],
};

// If a garment vertex ends up with no weight on allowed bones (e.g. a top
// vertex nearest to a leg), it is pinned entirely to this role's first bone.
const ANCHOR_ROLE: Record<GarmentKind, BoneRole> = {
  bottom: "hips",
  top: "spine",
  head: "head",
  face: "head",
};

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

/** How far forward of the head-bone centre the face surface sits, in head spans. */
const FACE_FORWARD = 0.48;

/**
 * Which way the avatar faces, taken from the feet (toes lead the ankles).
 * Flattened to horizontal so a tilted foot bone can't skew the result.
 */
function facing(byRole: Map<BoneRole, THREE.Vector3[]>): THREE.Vector3 {
  const avg = (pts: THREE.Vector3[]) =>
    pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const foot = byRole.get("foot");
  const toe = byRole.get("toe");
  if (foot?.length && toe?.length) {
    const dir = avg(toe).sub(avg(foot));
    dir.y = 0;
    if (dir.lengthSq() > 1e-8) return dir.normalize();
  }
  return new THREE.Vector3(0, 0, 1);
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

  if (kind === "head" || kind === "face") {
    const pts = byRole.get("head");
    if (!pts?.length) throw new Error("no head bone found in body.glb");
    const center = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length);
    // Head span from base to top-end bone; single-bone rigs estimate from the neck.
    const ys = pts.map((p) => p.y);
    let span = Math.max(...ys) - Math.min(...ys);
    if (span < 1e-4) span = Math.abs(center.y - at("neck", "shoulder").y) * 2;
    // Hats/hair wrap the whole skull, so they anchor at its centre. Eyes and
    // brows sit on the face, roughly half a head-span forward of that centre —
    // anchoring them at the centre leaves them stranded inside the skull, out
    // of reach of the (deliberately fine) depth slider.
    if (kind === "face") {
      return {
        center: center.clone().addScaledVector(facing(byRole), span * FACE_FORWARD),
        height: span * 0.4,
      };
    }
    return { center, height: span * 1.5 };
  }

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
/**
 * Body surface in its current pose, in mesh-local space (getVertexPosition
 * applies bind matrix + bone matrices per vertex for skinned meshes).
 */
function posedBodyGeometry(body: THREE.SkinnedMesh): THREE.BufferGeometry {
  const bodyGeo = body.geometry;
  body.updateMatrixWorld(true);
  const count = bodyGeo.attributes.position.count;
  const posed = new Float32Array(count * 3);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    body.getVertexPosition(i, tmp);
    posed[i * 3] = tmp.x;
    posed[i * 3 + 1] = tmp.y;
    posed[i * 3 + 2] = tmp.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(posed, 3));
  geo.setIndex(bodyGeo.index ? bodyGeo.index.clone() : null);
  return geo;
}

export function transferWeights(
  geometry: THREE.BufferGeometry,
  body: THREE.SkinnedMesh,
  kind: GarmentKind,
): void {
  const bodyGeo = body.geometry;
  const posedGeo = posedBodyGeometry(body);
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
  tPose = false,
): void {
  const rad = (angleDeg * Math.PI) / 180;
  const zAxis = new THREE.Vector3(0, 0, 1);
  const parentQ = new THREE.Quaternion();

  // Always start from rest: the T-pose touches clavicles and forearms too, and
  // the non-T-pose path below only rewrites upper arms.
  resetArms(restQuats);

  const isLeft = (name: string) => {
    const n = name.toLowerCase();
    return n.includes("left") || /(^|[^a-z])l[_\-.]/.test(n);
  };
  const rest = (bone: THREE.Bone) => {
    let q = restQuats.get(bone);
    if (!q) {
      q = bone.quaternion.clone();
      restQuats.set(bone, q);
    }
    return q;
  };

  const boneChild = (bone: THREE.Bone) =>
    bone.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;

  // Rotate a bone so its current direction points along `desired` (world space).
  const aimBone = (bone: THREE.Bone, desired: THREE.Vector3) => {
    const child = boneChild(bone);
    if (!child) return;
    bone.updateWorldMatrix(true, true);
    const from = child.getWorldPosition(new THREE.Vector3())
      .sub(bone.getWorldPosition(new THREE.Vector3()))
      .normalize();
    const qWorld = new THREE.Quaternion().setFromUnitVectors(from, desired);
    bone.parent!.getWorldQuaternion(parentQ);
    const qLocal = parentQ.clone().invert().multiply(qWorld).multiply(parentQ);
    bone.quaternion.premultiply(qLocal);
    bone.updateWorldMatrix(false, true);
  };

  // Clavicles first: auto-rigs often lean one shoulder back into the torso
  // (mirrored in X/Y but not Z), which leaves that arm rooted inside the body.
  // Re-aim both onto a shared, depth-free direction so the joints sit level.
  if (tPose) {
    const shoulders: Array<{ bone: THREE.Bone; sign: number; dir: THREE.Vector3 }> = [];
    for (const bone of body.skeleton.bones) {
      if (boneRole(bone.name) !== "shoulder" || !boneChild(bone)) continue;
      bone.quaternion.copy(rest(bone));
      bone.updateWorldMatrix(true, true);
      const dir = boneChild(bone)!
        .getWorldPosition(new THREE.Vector3())
        .sub(bone.getWorldPosition(new THREE.Vector3()))
        .normalize();
      shoulders.push({ bone, sign: isLeft(bone.name) ? 1 : -1, dir });
    }
    if (shoulders.length) {
      // The clavicle roots themselves can also sit at different depths, which
      // offsets a whole arm chain rigidly; rotation can't fix that, so mirror
      // the joint positions onto their average.
      const world = shoulders.map((e) => e.bone.getWorldPosition(new THREE.Vector3()));
      const mid = world
        .reduce((s, p, i) => s.add(new THREE.Vector3(Math.abs(p.x) * shoulders[i].sign, p.y, p.z)), new THREE.Vector3())
        .divideScalar(shoulders.length);
      const parentInv = new THREE.Matrix4();
      shoulders.forEach((e, i) => {
        e.bone.userData.restPos ??= e.bone.position.clone();
        const target = new THREE.Vector3(Math.abs(mid.x) * e.sign, mid.y, mid.z);
        parentInv.copy(e.bone.parent!.matrixWorld).invert();
        e.bone.position.copy(target.applyMatrix4(parentInv));
        e.bone.updateWorldMatrix(false, true);
        world[i].copy(target);
      });

      const spread = shoulders.reduce((s, e) => s + Math.abs(e.dir.x), 0) / shoulders.length;
      const drop = shoulders.reduce((s, e) => s + e.dir.y, 0) / shoulders.length;
      for (const e of shoulders) {
        aimBone(e.bone, new THREE.Vector3(e.sign * spread, drop, 0).normalize());
      }
    }
  }

  for (const bone of body.skeleton.bones) {
    if (boneRole(bone.name) !== "upperarm") continue;
    const left = isLeft(bone.name);
    const restQ = rest(bone);

    if (tPose) {
      // Straighten the whole chain onto the horizontal axis, then apply the
      // slider angle on top, so sleeves line up with a T-posed garment.
      const sign = left ? 1 : -1;
      const axis = new THREE.Vector3(sign * Math.cos(rad), Math.sin(rad), 0).normalize();
      bone.quaternion.copy(restQ);
      bone.updateWorldMatrix(true, true);
      aimBone(bone, axis);
      let link = boneChild(bone);
      while (link) {
        const role = boneRole(link.name);
        if (role !== "forearm" && role !== "upperarm") break;
        // Reset before aiming so repeated calls can't accumulate twist.
        link.quaternion.copy(rest(link));
        aimBone(link, axis);
        link = boneChild(link);
      }
      continue;
    }

    bone.parent!.getWorldQuaternion(parentQ);
    const qWorld = new THREE.Quaternion().setFromAxisAngle(zAxis, (left ? 1 : -1) * rad);
    const qLocal = parentQ.clone().invert().multiply(qWorld).multiply(parentQ);
    bone.quaternion.copy(qLocal.multiply(restQ));
  }
}

/** Restore arm bones cached by poseArms to their rest rotations (and positions). */
export function resetArms(restQuats: Map<THREE.Bone, THREE.Quaternion>): void {
  for (const [bone, q] of restQuats) {
    bone.quaternion.copy(q);
    const restPos = bone.userData.restPos as THREE.Vector3 | undefined;
    if (restPos) bone.position.copy(restPos);
  }
}

/**
 * Vertex adjacency with seam welding: vertices duplicated along UV seams are
 * merged by position so smoothing doesn't crack the mesh open.
 */
function weldedAdjacency(geo: THREE.BufferGeometry): { rep: Uint32Array; adj: Map<number, Set<number>> } {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const rep = new Uint32Array(count);
  const canon = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    const existing = canon.get(key);
    if (existing === undefined) {
      canon.set(key, i);
      rep[i] = i;
    } else {
      rep[i] = existing;
    }
  }
  const adj = new Map<number, Set<number>>();
  const link = (u: number, v: number) => {
    const a = rep[u];
    const b = rep[v];
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  const index = geo.index;
  const faces = (index ? index.count : count) / 3;
  for (let f = 0; f < faces; f++) {
    const i0 = index ? index.getX(f * 3) : f * 3;
    const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;
    link(i0, i1);
    link(i1, i2);
    link(i2, i0);
  }
  return { rep, adj };
}

/**
 * Shrinkwrap a fitted garment mesh onto the body: vertices inside the body are
 * pushed out to `clearance` above the surface, vertices within `influence` are
 * pulled toward it (scaled by `strength`), and the resulting displacement field
 * is smoothed so pockets/collars deform without denting. Distances are in body
 * space; the original shape is stashed for resetConform.
 */
export function conformMeshToBody(
  mesh: THREE.Mesh,
  body: THREE.SkinnedMesh,
  clearance: number,
  influence: number,
  strength: number,
): void {
  mesh.updateMatrixWorld(true);
  body.updateMatrixWorld(true);
  const geo = mesh.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;

  if (!geo.userData.origPositions) {
    geo.userData.origPositions = (pos.array as Float32Array).slice();
  }

  const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert().multiply(mesh.matrixWorld);
  const fromBody = new THREE.Matrix4().copy(toBody).invert();

  // Conform against the posed surface so an arm-posed avatar wraps correctly.
  const posedGeo = posedBodyGeometry(body);

  // Drop hand/finger faces from the target surface so sleeves stop at the
  // wrist instead of stretching to wrap the fingers.
  const srcIndex = body.geometry.attributes.skinIndex as THREE.BufferAttribute;
  const srcWeight = body.geometry.attributes.skinWeight as THREE.BufferAttribute;
  const handBones = new Set<number>();
  body.skeleton.bones.forEach((bone, i) => {
    if (boneRole(bone.name) === "hand") handBones.add(i);
  });
  const isHandVert = (vi: number) => {
    let w = 0;
    for (let ch = 0; ch < 4; ch++) {
      if (handBones.has(srcIndex.getComponent(vi, ch))) w += srcWeight.getComponent(vi, ch);
    }
    return w > 0.5;
  };
  const srcFaceIdx = posedGeo.index;
  const faceCount = (srcFaceIdx ? srcFaceIdx.count : posedGeo.attributes.position.count) / 3;
  const kept: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const i0 = srcFaceIdx ? srcFaceIdx.getX(f * 3) : f * 3;
    const i1 = srcFaceIdx ? srcFaceIdx.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = srcFaceIdx ? srcFaceIdx.getX(f * 3 + 2) : f * 3 + 2;
    if (isHandVert(i0) || isHandVert(i1) || isHandVert(i2)) continue;
    kept.push(i0, i1, i2);
  }
  posedGeo.setIndex(kept);

  const bvh = new MeshBVH(posedGeo);
  const bodyPos = posedGeo.attributes.position as THREE.BufferAttribute;
  const bodyIndex = posedGeo.index;

  // Garment vertices in body space, plus their displacement toward the goal.
  const local = new Float32Array(count * 3);
  const disp = new Float32Array(count * 3);

  const v = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const goal = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(toBody);
    local[i * 3] = v.x;
    local[i * 3 + 1] = v.y;
    local[i * 3 + 2] = v.z;

    bvh.closestPointToPoint(v, target);
    const f = target.faceIndex * 3;
    a.fromBufferAttribute(bodyPos, bodyIndex ? bodyIndex.getX(f) : f);
    b.fromBufferAttribute(bodyPos, bodyIndex ? bodyIndex.getX(f + 1) : f + 1);
    c.fromBufferAttribute(bodyPos, bodyIndex ? bodyIndex.getX(f + 2) : f + 2);
    n.copy(b).sub(a).cross(c.sub(a)).normalize();

    dir.copy(v).sub(target.point);
    const inside = dir.dot(n) < 0;
    const d = target.distance;

    let w = 0;
    if (inside) w = 1;
    else if (d <= influence) {
      w = strength * (1 - Math.max(0, d - clearance) / Math.max(influence - clearance, 1e-6));
    }
    if (w > 0) {
      goal.copy(n).multiplyScalar(clearance).add(target.point);
      disp[i * 3] = (goal.x - v.x) * w;
      disp[i * 3 + 1] = (goal.y - v.y) * w;
      disp[i * 3 + 2] = (goal.z - v.z) * w;
    }
  }

  // Smooth the displacement field over the welded vertex graph.
  const { rep, adj } = weldedAdjacency(geo);
  let cur = disp;
  let next = new Float32Array(count * 3);
  for (let it = 0; it < 8; it++) {
    next.set(cur);
    for (const [i, nbs] of adj) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const nb of nbs) {
        sx += cur[nb * 3];
        sy += cur[nb * 3 + 1];
        sz += cur[nb * 3 + 2];
      }
      const inv = 0.6 / nbs.size;
      next[i * 3] = cur[i * 3] * 0.4 + sx * inv;
      next[i * 3 + 1] = cur[i * 3 + 1] * 0.4 + sy * inv;
      next[i * 3 + 2] = cur[i * 3 + 2] * 0.4 + sz * inv;
    }
    [cur, next] = [next, cur];
  }

  for (let i = 0; i < count; i++) {
    const r = rep[i];
    v.set(local[i * 3] + cur[r * 3], local[i * 3 + 1] + cur[r * 3 + 1], local[i * 3 + 2] + cur[r * 3 + 2]);
    v.applyMatrix4(fromBody);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
}

/**
 * Copy of `mesh` reflected across the body's midline (world x=0), baked into
 * world space with identity transform so it can be bound directly. Used to
 * place one of a paired facial feature and get the other for free — safe only
 * for parts bound to centre bones, since it does not swap Left/Right joints.
 */
export function mirrorAcrossX(mesh: THREE.Mesh): THREE.Mesh {
  mesh.updateMatrixWorld(true);
  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);

  const pos = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  pos.needsUpdate = true;
  const nrm = geometry.attributes.normal as THREE.BufferAttribute | undefined;
  if (nrm) {
    for (let i = 0; i < nrm.count; i++) nrm.setX(i, -nrm.getX(i));
    nrm.needsUpdate = true;
  }
  // Reflection flips handedness, so triangles need rewinding to face outward.
  const index = geometry.index;
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const t = index.getX(i);
      index.setX(i, index.getX(i + 2));
      index.setX(i + 2, t);
    }
    index.needsUpdate = true;
  } else {
    // Non-indexed geometry (glTF allows it) would otherwise keep its original
    // winding and render inside-out. Adding a reversed index rewinds every
    // triangle without having to shuffle each attribute buffer in step.
    const n = pos.count - (pos.count % 3);
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i += 3) {
      order[i] = i + 2;
      order[i + 1] = i + 1;
      order[i + 2] = i;
    }
    geometry.setIndex(new THREE.BufferAttribute(order, 1));
  }
  geometry.computeBoundingSphere();

  const out = new THREE.Mesh(geometry, mesh.material);
  out.name = `${mesh.name || "garment"}_mirrored`;
  return out;
}

/** Restore a mesh's shape from before its first conformMeshToBody call. */
export function resetConform(mesh: THREE.Mesh): void {
  const geo = mesh.geometry;
  const orig = geo.userData.origPositions as Float32Array | undefined;
  if (!orig) return;
  (geo.attributes.position.array as Float32Array).set(orig);
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
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
