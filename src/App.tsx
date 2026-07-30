import { useRef, useState } from "react";
import {
  VIEW_ORDER,
  type MeshyKind,
  type ViewKey,
  createMeshyTask,
  fileToDataUri,
  pollMeshyTask,
  proxied,
} from "./lib/api";
import { Dropzone, type ViewImage } from "./components/Dropzone";
import { Viewer } from "./components/Viewer";
import { RigPanel } from "./components/RigPanel";

type Images = Record<ViewKey, ViewImage | null>;

interface HistoryEntry {
  taskId: string;
  type: string;
  modelUrl: string | null;
  posterUrl: string | null;
}

const MESHY_MODELS = ["latest", "meshy-6", "meshy-5"];
const POSE_MODES = ["t-pose", "a-pose", ""];

export default function App() {
  const [images, setImages] = useState<Images>({ front: null, left: null, back: null, right: null });
  const [modelVersion, setModelVersion] = useState(MESHY_MODELS[0]);
  const [details, setDetails] = useState("");
  const [poseMode, setPoseMode] = useState(POSE_MODES[0]);
  const [texture, setTexture] = useState(true);
  const [pbr, setPbr] = useState(true);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const rawModelUrl = useRef<string | null>(null);

  const provided = VIEW_ORDER.filter((v) => images[v]);

  // ?rigtest loads a local file as the garment so the dressing room can be
  // exercised without spending generation credits (dev only). Bare ?rigtest
  // uses the avatar itself; ?rigtest=/hair.glb loads that path from public/.
  const rigTestParam = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("rigtest")
    : null;
  const garmentUrl = modelUrl ?? (rigTestParam !== null ? rigTestParam || "/body.glb" : null);

  function publishResult(taskId: string, type: string, url: string, posterRaw: string | null) {
    rawModelUrl.current = url;
    const model = proxied(url);
    const poster = posterRaw ? proxied(posterRaw) : null;
    setModelUrl(model);
    setPosterUrl(poster);
    setLastTaskId(taskId);
    setHistory((h) => [{ taskId, type, modelUrl: model, posterUrl: poster }, ...h]);
    setStatus("done");
  }

  async function runMeshyTask(kind: MeshyKind, payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      setStatus("creating task…");
      const taskId = await createMeshyTask(kind, payload);
      setStatus("queued");
      const task = await pollMeshyTask(kind, taskId, (t) => {
        setStatus(t.status.toLowerCase().replace("_", " "));
        setProgress(t.progress ?? 0);
      });
      if (task.status !== "SUCCEEDED") {
        throw new Error(task.task_error?.message ?? `task ${task.status.toLowerCase()}`);
      }
      const url = task.model_urls?.glb ?? null;
      if (!url) throw new Error("task succeeded but returned no model url");
      publishResult(taskId, kind, url, task.thumbnail_url ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (provided.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setStatus("encoding images…");
      const uris = await Promise.all(provided.map((v) => fileToDataUri(images[v]!.file)));
      const options: Record<string, unknown> = {
        ai_model: modelVersion,
        should_texture: texture,
        enable_pbr: pbr,
      };
      if (details.trim()) options.texture_prompt = details.trim().slice(0, 600);
      if (provided.length === 1) {
        // pose_mode is only documented on the single-image endpoint.
        if (poseMode) options.pose_mode = poseMode;
        await runMeshyTask("image-to-3d", { image_url: uris[0], ...options });
      } else {
        await runMeshyTask("multi-image-to-3d", { image_urls: uris, ...options });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>3d-pipes</h1>
        <span className="muted">image → Meshy → asset</span>
      </header>

      <main>
        <section className="panel inputs">
          <h2>Views</h2>
          <div className="dropzone-grid">
            {VIEW_ORDER.map((v) => (
              <Dropzone
                key={v}
                view={v}
                image={images[v]}
                onChange={(img) => setImages((s) => ({ ...s, [v]: img }))}
              />
            ))}
          </div>

          <h2>Options</h2>
          <div className="options">
            <label>
              model
              <select value={modelVersion} onChange={(e) => setModelVersion(e.target.value)}>
                {MESHY_MODELS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              pose
              <select value={poseMode} onChange={(e) => setPoseMode(e.target.value)}>
                {POSE_MODES.map((p) => (
                  <option key={p} value={p}>
                    {p || "as-is"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input type="checkbox" checked={texture} onChange={(e) => setTexture(e.target.checked)} />
              texture
            </label>
            <label>
              <input type="checkbox" checked={pbr} onChange={(e) => setPbr(e.target.checked)} />
              PBR
            </label>
          </div>

          <h2>Details</h2>
          <textarea
            className="text-input details"
            rows={3}
            maxLength={600}
            placeholder="Optional context for the texture — e.g. “oversized denim jacket, brass buttons, distressed wash”"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />

          <button className="primary generate" disabled={busy || provided.length === 0} onClick={generate}>
            {busy ? "Working…" : provided.length > 1 ? "Generate (multiview)" : "Generate"}
          </button>

          {status && (
            <div className="status">
              <span>{status}</span>
              <progress max={100} value={progress} />
            </div>
          )}
          {error && <p className="error">{error}</p>}

          <h2>Garment</h2>
          <Viewer src={modelUrl} poster={posterUrl} />
          {modelUrl && (
            <div className="row output-actions">
              <a className="button" href={modelUrl} download="model.glb">
                Download GLB
              </a>
              {lastTaskId && <span className="muted">task {lastTaskId}</span>}
            </div>
          )}
          {history.length > 1 && (
            <>
              <h2>History</h2>
              <ul className="history">
                {history.map((h) => (
                  <li key={h.taskId}>
                    <button
                      className="link"
                      onClick={() => {
                        setModelUrl(h.modelUrl);
                        setPosterUrl(h.posterUrl);
                        setLastTaskId(h.taskId);
                      }}
                    >
                      {h.type} — {h.taskId.slice(0, 8)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="panel output">
          <h2>Dressing room</h2>
          <RigPanel key={garmentUrl ?? "avatar"} garmentUrl={garmentUrl} />
        </section>
      </main>
    </div>
  );
}
