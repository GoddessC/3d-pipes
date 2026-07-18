export type ViewKey = "front" | "left" | "back" | "right";
export const VIEW_ORDER: ViewKey[] = ["front", "left", "back", "right"];

export interface TaskOutput {
  model?: string;
  base_model?: string;
  pbr_model?: string;
  rendered_image?: string;
}

export interface TaskData {
  task_id: string;
  type: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "banned" | "expired" | "unknown";
  progress: number;
  output: TaskOutput;
  input?: unknown;
  create_time?: number;
}

interface TripoEnvelope<T> {
  code: number;
  data: T;
  message?: string;
  suggestion?: string;
}

async function unwrap<T>(res: Response): Promise<T> {
  const json = (await res.json()) as TripoEnvelope<T> & { error?: string };
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(json.message ?? json.error ?? `request failed (${res.status})`);
  }
  return json.data;
}

export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const data = await unwrap<{ image_token: string }>(
    await fetch("/api/upload", { method: "POST", body: form }),
  );
  return data.image_token;
}

export async function createTask(payload: Record<string, unknown>): Promise<string> {
  const data = await unwrap<{ task_id: string }>(
    await fetch("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return data.task_id;
}

export async function getTask(id: string): Promise<TaskData> {
  return unwrap<TaskData>(await fetch(`/api/task/${id}`));
}

const DONE_STATUSES = new Set(["success", "failed", "cancelled", "banned", "expired"]);

export async function pollTask(
  id: string,
  onProgress: (task: TaskData) => void,
  intervalMs = 2500,
): Promise<TaskData> {
  for (;;) {
    const task = await getTask(id);
    onProgress(task);
    if (DONE_STATUSES.has(task.status)) return task;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Route a Tripo output URL through the server proxy (CORS + short-lived URLs). */
export function proxied(url: string): string {
  return `/api/model?url=${encodeURIComponent(url)}`;
}

export function fileTypeOf(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "webp") return "webp";
  return "png";
}
