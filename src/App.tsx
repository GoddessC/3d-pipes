import { useRef, useState } from "react";
import {
  VIEW_ORDER,
  type TaskData,
  type ViewKey,
  createTask,
  fileTypeOf,
  pollTask,
  proxied,
  uploadImage,
} from "./lib/api";
import { Dropzone, type ViewImage } from "./components/Dropzone";
import { Viewer } from "./components/Viewer";
import { TweakPanel } from "./components/TweakPanel";

type Images = Record<ViewKey, ViewImage | null>;

interface HistoryEntry {
  taskId: string;
  type: string;
  modelUrl: string | null;
  posterUrl: string | null;
}

const MODEL_VERSIONS = ["v2.5-20250123", "v2.0-20240919", "v1.4-20240625"];

export default function App() {
  const [images, setImages] = useState<Images>({ front: null, left: null, back: null, right: null });
  const [modelVersion, setModelVersion] = useState(MODEL_VERSIONS[0]);
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

  async function runTask(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      setStatus("creating task…");
      const taskId = await createTask(payload);
      setStatus("queued");
      const task: TaskData = await pollTask(taskId, (t) => {
        setStatus(t.status);
        setProgress(t.progress ?? 0);
      });
      if (task.status !== "success") {
        throw new Error(`task ${task.status}`);
      }
      const url = task.output.pbr_model ?? task.output.model ?? task.output.base_model ?? null;
      if (!url) throw new Error("task succeeded but returned no model url");
      rawModelUrl.current = url;
      const model = proxied(url);
      const poster = task.output.rendered_image ? proxied(task.output.rendered_image) : null;
      setModelUrl(model);
      setPosterUrl(poster);
      setLastTaskId(taskId);
      setHistory((h) => [{ taskId, type: String(payload.type), modelUrl: model, posterUrl: poster }, ...h]);
      setStatus("done");
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
      setStatus("uploading images…");
      const tokens = Object.fromEntries(
        await Promise.all(
          provided.map(async (v) => [v, await uploadImage(images[v]!.file)] as const),
        ),
      ) as Partial<Record<ViewKey, string>>;

      const fileRef = (v: ViewKey) =>
        tokens[v] ? { type: fileTypeOf(images[v]!.file), file_token: tokens[v] } : {};

      const payload: Record<string, unknown> =
        provided.length === 1
          ? {
              type: "image_to_model",
              file: fileRef(provided[0]),
              model_version: modelVersion,
              texture,
              pbr,
            }
          : {
              type: "multiview_to_model",
              // Tripo expects [front, left, back, right]; missing views are {}.
              files: (["front", "left", "back", "right"] as ViewKey[]).map(fileRef),
              model_version: modelVersion,
              texture,
              pbr,
            };
      await runTask(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>3d-pipes</h1>
        <span className="muted">image → Tripo3D → asset</span>
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
                {MODEL_VERSIONS.map((m) => (
                  <option key={m}>{m}</option>
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

          <h2>Tweak</h2>
          <TweakPanel lastTaskId={lastTaskId} busy={busy} onRun={runTask} />
        </section>

        <section className="panel output">
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
      </main>
    </div>
  );
}
