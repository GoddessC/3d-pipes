# 3d-pipes

Drop reference images (front / left / back / right — not all required), generate a 3D asset with the
[Tripo3D API](https://developers.tripo3d.ai/en/docs), preview it in the browser, and iterate with
text-driven tweaks (retexture / stylize / refine, or a raw task payload).

## Setup

```sh
npm install
cp .env.example .env   # paste your Tripo API key into TRIPO_API_KEY
npm run dev
```

Open <http://localhost:5173>.

The API key never reaches the browser — a small Express proxy ([server/index.mjs](server/index.mjs))
holds it and forwards requests to `https://api.tripo3d.ai/v2/openapi`:

| Route | Purpose |
|-------|---------|
| `POST /api/upload` | multipart image upload → Tripo `image_token` |
| `POST /api/task` | create a generation task (body passed through verbatim) |
| `GET /api/task/:id` | poll task status |
| `GET /api/model?url=…` | stream a generated asset (Tripo output URLs are short-lived and not CORS-enabled) |

## Flow

1. Drop one or more view images. One image → `image_to_model`; multiple → `multiview_to_model`
   (ordered `[front, left, back, right]`, missing views sent as `{}`).
2. Generate, watch progress, and the resulting GLB renders in a `<model-viewer>` panel.
3. Tweak: type a description, pick a preset (Retexture / Stylize / Refine) — the panel shows the
   exact task JSON before it runs, and you can edit it freely. Each result is kept in a session
   history so you can flip back.

If Tripo changes an endpoint or field name, the proxy is a verbatim passthrough — adjust the payload
in the tweak editor or in [src/App.tsx](src/App.tsx).
