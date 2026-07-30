import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  type GarmentKind,
  bindGarment,
  collectMeshes,
  conformMeshToBody,
  exportGlb,
  findBodyMesh,
  fitFrame,
  loadGltf,
  poseArms,
  resetConform,
} from "../lib/rig";

interface Props {
  /** Proxied URL of the generated item to preview, or null for avatar only. */
  garmentUrl: string | null;
}

// "idle" = avatar only, no garment loaded yet.
type Phase = "loading" | "idle" | "fitting" | "bound";

interface Bag {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  controls: OrbitControls;
  bodyRoot: THREE.Object3D;
  bodyMesh: THREE.SkinnedMesh;
  bodyHeight: number;
  clips: THREE.AnimationClip[];
  garmentGroup: THREE.Group | null;
  garmentSize: number;
  garmentCenter: THREE.Vector3;
  rigged: THREE.SkinnedMesh[];
  mixer: THREE.AnimationMixer | null;
  raf: number;
}

export function RigPanel({ garmentUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bagRef = useRef<Bag | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [kind, setKind] = useState<GarmentKind>("top");
  const [fitMode, setFitMode] = useState<"auto" | "authored">("auto");
  const [lengthMult, setLengthMult] = useState(1);
  const [widthMult, setWidthMult] = useState(1);
  const [offX, setOffX] = useState(0);
  const [offY, setOffY] = useState(0);
  const [offZ, setOffZ] = useState(0);
  const [rotY, setRotY] = useState(0);
  const [armDeg, setArmDeg] = useState(0);
  const [conformed, setConformed] = useState(false);
  const [pose, setPose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const armRest = useRef(new Map<THREE.Bone, THREE.Quaternion>());

  // Build the scene once the dressing room is opened.
  useEffect(() => {
    if (phase !== "loading") return;
    let disposed = false;
    (async () => {
      try {
        const [bodyGltf, garmentGltf] = await Promise.all([
          loadGltf("/body.glb"),
          garmentUrl ? loadGltf(garmentUrl) : Promise.resolve(null),
        ]);
        if (disposed || !containerRef.current) return;

        const container = containerRef.current;
        const width = container.clientWidth || 600;
        const height = 640;
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 2.4));
        const dir = new THREE.DirectionalLight(0xffffff, 2);
        dir.position.set(2, 3, 2);
        scene.add(dir);

        const bodyRoot = bodyGltf.scene;
        // Tripo/FBX exports often mark the skin material as alpha-blended,
        // which lets far surfaces (opposite ear/arm) draw through near ones.
        bodyRoot.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              m.transparent = false;
              m.depthWrite = true;
            }
          }
        });
        scene.add(bodyRoot);
        bodyRoot.updateMatrixWorld(true);
        const bodyMesh = findBodyMesh(bodyRoot);
        // Frame the camera from bone positions: a static-geometry bounding box
        // is wrong for skinned meshes whose armature carries scale (Mixamo/FBX).
        const bbox = new THREE.Box3();
        bodyRoot.traverse((o) => {
          if ((o as THREE.Bone).isBone) {
            bbox.expandByPoint(o.getWorldPosition(new THREE.Vector3()));
          }
        });
        if (bbox.isEmpty()) bbox.setFromObject(bodyRoot);
        const center = bbox.getCenter(new THREE.Vector3());
        const bodyHeight = bbox.getSize(new THREE.Vector3()).y * 1.15; // bones sit inside the flesh

        const camera = new THREE.PerspectiveCamera(40, width / height, bodyHeight / 100, bodyHeight * 20);
        camera.position.set(center.x, center.y + bodyHeight * 0.1, center.z + bodyHeight * 1.8);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.copy(center);

        // Center the garment inside a group so fitting is scale + position only.
        let garmentGroup: THREE.Group | null = null;
        let garmentSize = 1;
        const garmentCenter = new THREE.Vector3();
        if (garmentGltf) {
          const gScene = garmentGltf.scene;
          const gBox = new THREE.Box3().setFromObject(gScene);
          const gCenter = gBox.getCenter(new THREE.Vector3());
          garmentCenter.copy(gCenter);
          garmentSize = Math.max(gBox.getSize(new THREE.Vector3()).y, 1e-6);
          gScene.position.sub(gCenter);
          garmentGroup = new THREE.Group();
          garmentGroup.add(gScene);
          scene.add(garmentGroup);
        }

        const bag: Bag = {
          renderer,
          scene,
          controls,
          bodyRoot,
          bodyMesh,
          bodyHeight,
          clips: bodyGltf.animations,
          garmentGroup,
          garmentSize,
          garmentCenter,
          rigged: [],
          mixer: null,
          raf: 0,
        };
        bagRef.current = bag;
        if (import.meta.env.DEV) (window as unknown as { __rig?: Bag }).__rig = bag;

        const clock = new THREE.Clock();
        const loop = () => {
          bag.raf = requestAnimationFrame(loop);
          bag.mixer?.update(clock.getDelta());
          controls.update();
          renderer.render(scene, camera);
        };
        loop();
        setPhase(garmentGroup ? "fitting" : "idle");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
      }
    })();
    return () => {
      disposed = true;
    };
  }, [phase, garmentUrl]);

  // Re-apply the fit whenever kind or a slider changes.
  useEffect(() => {
    const bag = bagRef.current;
    if (!bag?.garmentGroup || phase !== "fitting") return;
    try {
      // "authored" keeps the file's own placement (for assets built in body
      // space); "auto" scales/centers the garment onto the body region.
      const anchor = fitMode === "authored" ? bag.garmentCenter : fitFrame(bag.bodyRoot, kind).center;
      const base = fitMode === "authored" ? 1 : fitFrame(bag.bodyRoot, kind).height / bag.garmentSize;
      // length scales the garment vertically, width its girth (side + front-to-back).
      bag.garmentGroup.scale.set(base * widthMult, base * lengthMult, base * widthMult);
      bag.garmentGroup.position.set(
        anchor.x + offX * bag.bodyHeight * 0.25,
        anchor.y + offY * bag.bodyHeight * 0.25,
        anchor.z + offZ * bag.bodyHeight * 0.25,
      );
      bag.garmentGroup.rotation.y = (rotY * Math.PI) / 180;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [phase, kind, fitMode, lengthMult, widthMult, offX, offY, offZ, rotY]);

  // Pose the avatar's arms to line up with the garment's sleeves.
  useEffect(() => {
    const bag = bagRef.current;
    if (!bag || phase !== "fitting") return;
    poseArms(bag.bodyMesh, armRest.current, armDeg);
    bag.bodyRoot.updateMatrixWorld(true);
  }, [phase, armDeg]);

  // Dispose the renderer on unmount.
  useEffect(
    () => () => {
      const bag = bagRef.current;
      if (bag) {
        cancelAnimationFrame(bag.raf);
        bag.renderer.dispose();
        bag.renderer.domElement.remove();
      }
    },
    [],
  );

  function stopPose(bag: Bag) {
    bag.mixer?.stopAllAction();
    bag.bodyMesh.skeleton.pose();
  }

  function bind() {
    const bag = bagRef.current;
    if (!bag?.garmentGroup) return;
    setError(null);
    try {
      const meshes = collectMeshes(bag.garmentGroup);
      if (meshes.length === 0) throw new Error("garment has no meshes");
      bag.rigged = meshes.map((m) => bindGarment(m, bag.bodyMesh, kind));
      bag.scene.remove(bag.garmentGroup);
      setPhase("bound");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function conform() {
    const bag = bagRef.current;
    if (!bag?.garmentGroup) return;
    setError(null);
    try {
      const clearance = 0.008 * bag.bodyHeight;
      const influence = clearance + 0.08 * bag.bodyHeight;
      collectMeshes(bag.garmentGroup).forEach((m) =>
        conformMeshToBody(m, bag.bodyMesh, clearance, influence, 0.8),
      );
      setConformed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function resetShape() {
    const bag = bagRef.current;
    if (!bag?.garmentGroup) return;
    collectMeshes(bag.garmentGroup).forEach(resetConform);
    setConformed(false);
  }

  function refit() {
    const bag = bagRef.current;
    if (!bag?.garmentGroup) return;
    stopPose(bag);
    setPose("");
    bag.rigged.forEach((m) => m.parent?.remove(m));
    bag.rigged = [];
    bag.scene.add(bag.garmentGroup);
    setPhase("fitting");
  }

  function selectPose(name: string) {
    const bag = bagRef.current;
    if (!bag) return;
    setPose(name);
    if (!name) {
      stopPose(bag);
      return;
    }
    bag.mixer ??= new THREE.AnimationMixer(bag.bodyRoot);
    bag.mixer.stopAllAction();
    const clip = bag.clips.find((c) => c.name === name);
    if (clip) bag.mixer.clipAction(clip).reset().play();
  }

  async function download(dressed: boolean) {
    const bag = bagRef.current;
    if (!bag) return;
    setError(null);
    setPose("");
    stopPose(bag);
    // For a garment-only export, temporarily detach the body's own meshes so
    // the file keeps just the skeleton + rigged garment.
    const detached: Array<[THREE.Object3D, THREE.Object3D]> = [];
    if (!dressed) {
      const bodySkins: THREE.SkinnedMesh[] = [];
      bag.bodyRoot.traverse((o) => {
        if (o instanceof THREE.SkinnedMesh && !bag.rigged.includes(o)) bodySkins.push(o);
      });
      bodySkins.forEach((m) => {
        detached.push([m, m.parent!]);
        m.parent!.remove(m);
      });
    }
    try {
      const blob = await exportGlb(bag.bodyRoot, bag.clips);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = dressed ? "avatar-dressed.glb" : `${kind}-rigged.glb`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      detached.forEach(([m, parent]) => parent.add(m));
    }
  }

  return (
    <div className="rig-panel">
      {phase === "idle" && (
        <p className="muted">Generate an item to preview and rig it on the avatar.</p>
      )}
      {phase !== "loading" && (
        <div className="row">
          <label>
            animation
            <select value={pose} onChange={(e) => selectPose(e.target.value)}>
              <option value="">rest</option>
              {bagRef.current?.clips.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {(phase === "fitting" || phase === "bound") && (
      <div className="row">
        <label>
          garment
          <select
            value={kind}
            disabled={phase === "bound"}
            onChange={(e) => setKind(e.target.value as GarmentKind)}
          >
            <option value="top">top (upper body)</option>
            <option value="bottom">bottom (lower body)</option>
            <option value="head">head (hat/hair)</option>
          </select>
        </label>
        <label>
          placement
          <select
            value={fitMode}
            disabled={phase === "bound"}
            onChange={(e) => setFitMode(e.target.value as "auto" | "authored")}
          >
            <option value="auto">auto-fit</option>
            <option value="authored">as authored</option>
          </select>
        </label>
        {phase === "fitting" && (
          <>
            <button onClick={conform}>Conform to body</button>
            {conformed && <button onClick={resetShape}>Reset shape</button>}
            <button className="primary" onClick={bind}>
              Bind to skeleton
            </button>
          </>
        )}
        {phase === "bound" && (
          <>
            <button onClick={refit}>Re-fit</button>
            <button onClick={() => download(false)}>Garment GLB</button>
            <button onClick={() => download(true)}>Dressed GLB</button>
          </>
        )}
      </div>
      )}

      {phase === "fitting" && (
        <div className="rig-sliders">
          <label>
            length
            <input type="range" min={0.4} max={2} step={0.01} value={lengthMult}
              onChange={(e) => setLengthMult(Number(e.target.value))} />
          </label>
          <label>
            width
            <input type="range" min={0.4} max={2} step={0.01} value={widthMult}
              onChange={(e) => setWidthMult(Number(e.target.value))} />
          </label>
          <label>
            side
            <input type="range" min={-1} max={1} step={0.01} value={offX}
              onChange={(e) => setOffX(Number(e.target.value))} />
          </label>
          <label>
            height
            <input type="range" min={-1} max={1} step={0.01} value={offY}
              onChange={(e) => setOffY(Number(e.target.value))} />
          </label>
          <label>
            depth
            <input type="range" min={-1} max={1} step={0.01} value={offZ}
              onChange={(e) => setOffZ(Number(e.target.value))} />
          </label>
          <label>
            rotate
            <input type="range" min={0} max={360} step={1} value={rotY}
              onChange={(e) => setRotY(Number(e.target.value))} />
          </label>
          <label>
            arms
            <input type="range" min={-90} max={90} step={1} value={armDeg}
              onChange={(e) => setArmDeg(Number(e.target.value))} />
          </label>
        </div>
      )}

      <div ref={containerRef} className="rig-canvas">
        {phase === "loading" && (
          <span className="muted">{garmentUrl ? "loading avatar + garment…" : "loading avatar…"}</span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
