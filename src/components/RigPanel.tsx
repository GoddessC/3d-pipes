import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  type GarmentKind,
  bindGarment,
  collectMeshes,
  conformMeshToBody,
  exportGlb,
  mirrorAcrossX,
  findBodyMesh,
  fitFrame,
  loadGltf,
  poseArms,
  resetArms,
  resetConform,
} from "../lib/rig";

interface Props {
  /** Proxied URL of the generated item to preview, or null for avatar only. */
  garmentUrl: string | null;
}

// "idle" = avatar only, no garment loaded yet.
type Phase = "loading" | "idle" | "fitting" | "bound";

// Kinds bound entirely to centre bones, so a mirrored copy needs no L/R swap.
const CENTRE_BOUND = new Set<GarmentKind>(["head", "face"]);

function Slider({
  label,
  value,
  onChange,
  digits = 3,
  ...range
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  digits?: number;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <label>
      {label}
      <input type="range" {...range} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{value.toFixed(digits)}</span>
    </label>
  );
}

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
  const [tPose, setTPose] = useState(true);
  const [conformed, setConformed] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [pose, setPose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const armRest = useRef(new Map<THREE.Bone, THREE.Quaternion>());
  // Exports go out in the skeleton's bind pose so they match body.glb; the ref
  // suppresses the pose effect (and re-entrant clicks) for the export's
  // duration, and the tick re-runs that effect from fresh state afterwards.
  const exporting = useRef(false);
  const [exportTick, setExportTick] = useState(0);

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

        // Key/fill ride with the camera, so whichever side is facing the viewer
        // is the side that is lit. Positions are camera-local: -Z is forward.
        const key = new THREE.DirectionalLight(0xffffff, 1.8);
        key.position.set(0.5, 0.8, 1);
        key.target.position.set(0, 0, -1);
        const fill = new THREE.DirectionalLight(0xffffff, 0.5);
        fill.position.set(-0.8, -0.2, 0.6);
        fill.target.position.set(0, 0, -1);
        camera.add(key, key.target, fill, fill.target);
        scene.add(camera);

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

  // The avatar's static pose (T-pose by default) whenever no clip is playing.
  // Runs before the fit effect so garment placement sees the posed skeleton.
  useEffect(() => {
    const bag = bagRef.current;
    if (!bag || phase === "loading" || pose || exporting.current) return;
    poseArms(bag.bodyMesh, armRest.current, armDeg, tPose);
    bag.bodyRoot.updateMatrixWorld(true);
  }, [phase, pose, armDeg, tPose, exportTick]);

  // Re-apply the fit whenever kind or a slider changes.
  useEffect(() => {
    const bag = bagRef.current;
    if (!bag?.garmentGroup || phase !== "fitting") return;
    try {
      const frame = fitFrame(bag.bodyRoot, kind);
      // "authored" keeps the file's own placement (for assets built in body
      // space); "auto" scales/centers the garment onto the body region.
      const anchor = fitMode === "authored" ? bag.garmentCenter : frame.center;
      const base = fitMode === "authored" ? 1 : frame.height / bag.garmentSize;
      // length scales the garment vertically, width its girth (side + front-to-back).
      bag.garmentGroup.scale.set(base * widthMult, base * lengthMult, base * widthMult);
      // Nudge range follows the fitted region, so an eyebrow gets face-sized
      // precision from the same slider that moves a jacket torso-sized amounts.
      const nudge = frame.height * 0.6;
      bag.garmentGroup.position.set(
        anchor.x + offX * nudge,
        anchor.y + offY * nudge,
        anchor.z + offZ * nudge,
      );
      bag.garmentGroup.rotation.y = (rotY * Math.PI) / 180;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [phase, kind, fitMode, lengthMult, widthMult, offX, offY, offZ, rotY, pose, tPose, armDeg]);

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

  /** Stop any clip and return the skeleton to its bind pose. */
  function stopPose(bag: Bag) {
    bag.mixer?.stopAllAction();
    bag.bodyMesh.skeleton.pose();
    resetArms(armRest.current);
    bag.bodyRoot.updateMatrixWorld(true);
  }

  /** Bind pose + the current static pose (T-pose / arm angle). */
  function restPose(bag: Bag) {
    stopPose(bag);
    poseArms(bag.bodyMesh, armRest.current, armDeg, tPose);
    bag.bodyRoot.updateMatrixWorld(true);
  }

  function bind() {
    const bag = bagRef.current;
    if (!bag?.garmentGroup) return;
    setError(null);
    // Weights are sampled off the live body surface, so never bind mid-clip.
    setPose("");
    restPose(bag);
    try {
      const meshes = collectMeshes(bag.garmentGroup);
      if (meshes.length === 0) throw new Error("garment has no meshes");
      // Mirroring is only safe for centre-bone parts (it doesn't swap L/R joints).
      const toBind = mirror && CENTRE_BOUND.has(kind)
        ? meshes.flatMap((m) => [m, mirrorAcrossX(m)])
        : meshes;
      bag.rigged = toBind.map((m) => bindGarment(m, bag.bodyMesh, kind));
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
    setPose("");
    restPose(bag);
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
    restPose(bag);
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
      restPose(bag);
      return;
    }
    bag.mixer ??= new THREE.AnimationMixer(bag.bodyRoot);
    bag.mixer.stopAllAction();
    const clip = bag.clips.find((c) => c.name === name);
    if (clip) bag.mixer.clipAction(clip).reset().play();
  }

  async function download(dressed: boolean) {
    const bag = bagRef.current;
    // Overlapping exports would walk a scene the other one has detached.
    if (!bag || exporting.current) return;
    setError(null);
    setPose("");
    exporting.current = true;
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
      // The anchor has to be in the document for the click to count, and the
      // blob URL has to outlive it — revoking synchronously cancels the save.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = dressed ? "avatar-dressed.glb" : `${kind}-rigged.glb`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      detached.forEach(([m, parent]) => parent.add(m));
      exporting.current = false;
      // Re-pose via the effect so it picks up any change made during the
      // export rather than the values captured when the click happened.
      setExportTick((t) => t + 1);
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
          <label>
            <input
              type="checkbox"
              checked={tPose}
              disabled={!!pose}
              onChange={(e) => setTPose(e.target.checked)}
            />
            T-pose
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
            <option value="face">face (eyes/brows)</option>
          </select>
        </label>
        {CENTRE_BOUND.has(kind) && phase === "fitting" && (
          <label>
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
            mirror
          </label>
        )}
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
          <Slider label="length" min={0.05} max={2} step={0.005} value={lengthMult} onChange={setLengthMult} />
          <Slider label="width" min={0.05} max={2} step={0.005} value={widthMult} onChange={setWidthMult} />
          <Slider label="side" min={-1} max={1} step={0.005} value={offX} onChange={setOffX} />
          <Slider label="height" min={-1} max={1} step={0.005} value={offY} onChange={setOffY} />
          <Slider label="depth" min={-1} max={1} step={0.005} value={offZ} onChange={setOffZ} />
          <Slider label="rotate" min={0} max={360} step={1} value={rotY} onChange={setRotY} digits={0} />
          <Slider label="arms" min={-90} max={90} step={1} value={armDeg} onChange={setArmDeg} digits={0} />
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
