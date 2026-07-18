import { useState } from "react";

interface Props {
  lastTaskId: string | null;
  busy: boolean;
  onRun: (payload: Record<string, unknown>) => void;
}

type Preset = "retexture" | "stylize" | "refine";

function buildPreset(preset: Preset, taskId: string, prompt: string): Record<string, unknown> {
  switch (preset) {
    case "retexture":
      return {
        type: "texture_model",
        original_model_task_id: taskId,
        texture: true,
        pbr: true,
        text_prompt: prompt || undefined,
      };
    case "stylize":
      return { type: "stylize_model", original_model_task_id: taskId, style: prompt || "lego" };
    case "refine":
      return { type: "refine_model", draft_model_task_id: taskId };
  }
}

export function TweakPanel({ lastTaskId, busy, onRun }: Props) {
  const [prompt, setPrompt] = useState("");
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!lastTaskId) {
    return <p className="muted">Generate a model first, then tweak it here.</p>;
  }

  const loadPreset = (preset: Preset) => {
    setError(null);
    setJson(JSON.stringify(buildPreset(preset, lastTaskId, prompt), null, 2));
  };

  const run = () => {
    try {
      const payload = JSON.parse(json) as Record<string, unknown>;
      setError(null);
      onRun(payload);
    } catch {
      setError("Payload is not valid JSON.");
    }
  };

  return (
    <div className="tweak-panel">
      <input
        className="text-input"
        placeholder="Describe the tweak (e.g. weathered bronze finish, style name…)"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="row">
        <button onClick={() => loadPreset("retexture")}>Retexture</button>
        <button onClick={() => loadPreset("stylize")}>Stylize</button>
        <button onClick={() => loadPreset("refine")}>Refine</button>
      </div>
      <textarea
        className="json-editor"
        rows={9}
        spellCheck={false}
        placeholder="Pick a preset above, or write a raw Tripo task payload…"
        value={json}
        onChange={(e) => setJson(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !json.trim()} onClick={run}>
        Run tweak
      </button>
    </div>
  );
}
