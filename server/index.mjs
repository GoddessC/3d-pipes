import "dotenv/config";
import express from "express";
import multer from "multer";

const API_BASE = process.env.TRIPO_API_BASE ?? "https://api.tripo3d.ai/v2/openapi";
const API_KEY = process.env.TRIPO_API_KEY;
const MESHY_API_BASE = process.env.MESHY_API_BASE ?? "https://api.meshy.ai/openapi/v1";
const MESHY_API_KEY = process.env.MESHY_API_KEY;
const PORT = process.env.PORT ?? 5174;

if (!API_KEY) {
  console.warn("TRIPO_API_KEY is not set — copy .env.example to .env and add your key. API calls will fail until then.");
}
if (!MESHY_API_KEY) {
  console.warn("MESHY_API_KEY is not set — Meshy generation will fail until it is added to .env.");
}

const app = express();
// Meshy tasks send images inline as base64 data URIs, so the JSON body can be large.
app.use(express.json({ limit: "40mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const authHeaders = { Authorization: `Bearer ${API_KEY}` };

// Upload an image, returns Tripo's image token.
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    const r = await fetch(`${API_BASE}/upload/sts`, { method: "POST", headers: authHeaders, body: form });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Create a generation task. Body is passed through verbatim to Tripo.
app.post("/api/task", async (req, res) => {
  try {
    const r = await fetch(`${API_BASE}/task`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Poll task status.
app.get("/api/task/:id", async (req, res) => {
  try {
    const r = await fetch(`${API_BASE}/task/${encodeURIComponent(req.params.id)}`, { headers: authHeaders });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Account balance, handy for the header widget.
app.get("/api/balance", async (_req, res) => {
  try {
    const r = await fetch(`${API_BASE}/user/balance`, { headers: authHeaders });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Meshy proxy. Task kind is part of the URL because Meshy uses a separate
// endpoint per task type (image-to-3d, multi-image-to-3d) for create and poll.
const MESHY_KINDS = new Set(["image-to-3d", "multi-image-to-3d"]);
const meshyHeaders = { Authorization: `Bearer ${MESHY_API_KEY}` };

app.post("/api/meshy/:kind", async (req, res) => {
  if (!MESHY_KINDS.has(req.params.kind)) return res.status(404).json({ error: "unknown task kind" });
  try {
    const r = await fetch(`${MESHY_API_BASE}/${req.params.kind}`, {
      method: "POST",
      headers: { ...meshyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/meshy/:kind/:id", async (req, res) => {
  if (!MESHY_KINDS.has(req.params.kind)) return res.status(404).json({ error: "unknown task kind" });
  try {
    const r = await fetch(`${MESHY_API_BASE}/${req.params.kind}/${encodeURIComponent(req.params.id)}`, {
      headers: meshyHeaders,
    });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Stream a generated asset through the server. Tripo output URLs are
// short-lived and not CORS-enabled, so the browser fetches them via this proxy.
app.get("/api/model", async (req, res) => {
  try {
    const url = new URL(String(req.query.url));
    if (
      !/(^|\.)tripo3d\.(ai|com)$/.test(url.hostname) &&
      !/(^|\.)meshy\.ai$/.test(url.hostname) &&
      !url.hostname.endsWith(".amazonaws.com")
    ) {
      return res.status(400).json({ error: "url host not allowed" });
    }
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: `upstream ${r.status}` });
    res.setHeader("Content-Type", r.headers.get("content-type") ?? "application/octet-stream");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`tripo proxy listening on http://localhost:${PORT}`));
