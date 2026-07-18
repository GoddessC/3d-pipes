export type ViewKey = "front" | "left" | "back" | "right";
export const VIEW_ORDER: ViewKey[] = ["front", "left", "back", "right"];

// Meshy uses one endpoint per task kind, both for create and poll.
export type MeshyKind = "image-to-3d" | "multi-image-to-3d";

export interface MeshyTask {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  progress: number;
  model_urls?: { glb?: string };
  thumbnail_url?: string;
  task_error?: { message?: string };
}

async function meshyJson<T>(res: Response): Promise<T> {
  const json = (await res.json()) as T & { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(json.message ?? json.error ?? `request failed (${res.status})`);
  }
  return json;
}

export async function createMeshyTask(kind: MeshyKind, payload: Record<string, unknown>): Promise<string> {
  const data = await meshyJson<{ result: string }>(
    await fetch(`/api/meshy/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return data.result;
}

export async function getMeshyTask(kind: MeshyKind, id: string): Promise<MeshyTask> {
  return meshyJson<MeshyTask>(await fetch(`/api/meshy/${kind}/${id}`));
}

const MESHY_DONE_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);

export async function pollMeshyTask(
  kind: MeshyKind,
  id: string,
  onProgress: (task: MeshyTask) => void,
  intervalMs = 2500,
): Promise<MeshyTask> {
  for (;;) {
    const task = await getMeshyTask(kind, id);
    onProgress(task);
    if (MESHY_DONE_STATUSES.has(task.status)) return task;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Meshy accepts images inline as base64 data URIs, so no upload round-trip is needed. */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}

/** Route a generated-asset URL through the server proxy (CORS + short-lived URLs). */
export function proxied(url: string): string {
  return `/api/model?url=${encodeURIComponent(url)}`;
}
