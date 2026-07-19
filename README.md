# 3d-pipes

Turn clothing reference images into **rigged, animation-ready garments** for a 3D avatar — entirely in the browser.

Drop reference photos, generate a 3D garment with the [Meshy API](https://docs.meshy.ai), then fit and bind it to a humanoid avatar in the built-in **dressing room**: pick top or bottom, line it up with fit sliders, and the app transfers skin weights from the avatar's body onto the garment — restricted to upper-body bones for tops and lower-body bones for bottoms. Preview the result in any of the avatar's animations and export a rigged GLB.

> The pipeline currently works with **GLB files** (glTF binary) end to end — the avatar, the generated garments, and the exports.

## Setup

```sh
npm install
cp .env.example .env   # add your Meshy API key as MESHY_API_KEY
npm run dev
```

Open <http://localhost:5173>.

Your API key never reaches the browser — a small Express proxy ([server/index.mjs](server/index.mjs)) holds it and forwards requests to Meshy. Generated-asset URLs are also streamed through the proxy because they are short-lived and not CORS-enabled.

## Workflow

1. **Drop reference images** into the view slots (front / left / back / right — one is enough).
   One image uses Meshy's `image-to-3d`; multiple use `multi-image-to-3d`.
2. **Add details** (optional) — free text sent as Meshy's `texture_prompt` to guide texturing,
   e.g. *"oversized denim jacket, brass buttons, distressed wash"*. The **pose** option requests
   a T-pose or A-pose result, which makes the next step easier.
3. **Generate** and watch the model appear in the viewer.
4. **Dressing room** — the generated item loads next to the avatar:
   - choose **top** (upper body) or **bottom** (lower body);
   - use the **scale / height / depth / rotate** sliders to align it over the avatar;
   - use the **arms** slider to raise the avatar's arms into the sleeves — binding is
     pose-aware, so match the garment's pose before binding;
   - hit **Bind to skeleton**. Every garment vertex copies skin weights from the closest
     point on the body surface, limited to the bone set for its garment type
     (tops: spine/shoulders/arms/hands/neck; bottoms: hips/legs/feet — hips in both so
     waistbands and hems follow the pelvis).
5. **Preview animations** from the dropdown to check the deformation, then export:
   - **Garment GLB** — skeleton + rigged garment only (for layering in an engine);
   - **Dressed GLB** — the avatar wearing the garment. Both keep the avatar's animations.

## Using your own avatar

The avatar is a single file: [`public/body.glb`](public/body.glb). Replace it with your own and the whole app — fitting, weight transfer, animation preview — picks it up on reload. No code changes needed if the file meets these requirements:

- **GLB format** with a **skinned mesh** — the mesh must carry skin weights
  (`JOINTS_0`/`WEIGHTS_0` bound to a skeleton). A mesh and an armature sitting side by side
  in the same file is not enough; the weights are what get copied onto garments.
- **Humanoid skeleton with recognizable bone names.** Bones are matched by keyword, not
  exact name, so Mixamo (`mixamorig:LeftUpLeg`), Tripo (`L_Thigh`, `L_CalfTwist01`), and
  similar conventions all work out of the box. Fingers and twist bones are handled
  automatically if present.
- **Y-up, standing upright, roughly at origin** — the standard glTF convention.
- **Opaque materials.** Some exporters mark skin materials as alpha-blended, which makes
  far surfaces show through near ones. The app forces the avatar's materials opaque at
  load, but exporting them opaque is cleaner.

**Animations ride along for free**: any clips baked into the GLB show up in the dressing
room's *animation* dropdown, playable on the bare avatar or the dressed one. Give the clips
readable names in your DCC tool — the dropdown shows them verbatim.

### Getting a rigged GLB from Mixamo (typical path)

1. Upload your character mesh to [Mixamo](https://www.mixamo.com) and auto-rig it
   (choose a skeleton with fingers if you want them).
2. Download as **FBX** with **Skin: With Skin**. Add animation clips the same way.
3. In Blender: import the FBX, stack extra clips in the NLA if you have them, then
   export as **glTF 2.0 (GLB)**.
4. Drop the result in as `public/body.glb`.

Watch out for the classic Mixamo/Blender pitfalls — 100× armature scale, a rest pose that
doesn't match the animation, and alpha-blended materials. If the avatar loads sideways,
tiny, or see-through, the export needs normalizing (apply transforms in Blender and
re-export).

## Dev notes

- `npm run dev` runs the Vite app on `:5173` and the API proxy on `:5174` concurrently.
- Append `?rigtest` to the URL in dev to load the avatar itself as a stand-in garment —
  lets you exercise the whole dressing-room flow without spending generation credits.
- Weight transfer internals live in [src/lib/rig.ts](src/lib/rig.ts): closest-point lookup
  via [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh), barycentric weight
  interpolation, bone-subset filtering, and inverse-skinning "un-posing" so garments fitted
  against a posed avatar still bind in rest space.
