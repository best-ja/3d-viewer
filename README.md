# BMA BWIM System

A phone-first 3D viewer for the bridge weigh-in-motion installations. Pick a bridge, pick a sensor
type, and every unit of that type lights up on the model while the camera moves to a view that
shows them — for weight sensors, that means going under the deck and looking up at the girders.

It shows where equipment is. It records nothing and reports no readings.

## Run it locally

Any static server works; the GLBs are fetched with `fetch`, so opening `index.html` from the
filesystem will not work.

```bash
python -m http.server 5501
# then http://localhost:5501/
```

VS Code Live Server is already configured for port 5501 in `.vscode/settings.json`.

To try it on a phone on the same Wi-Fi, use `http://<your-lan-ip>:5501/`. Everything works except
**compass mode**, which browsers only allow on a secure origin — see below.

## Deploy to GitHub Pages

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then **Settings ▸ Pages ▸ Deploy from a branch ▸ `main` / `(root)`**.

- Free HTTPS comes with it, which is what compass mode needs.
- Size is fine: the largest model is 16 MB against a 100 MB per-file limit, and ~64 MB total
  against the 1 GB published-site limit.
- `.nojekyll` is committed so Pages serves the files as-is.
- **Pages is public.** A GitHub Pages site is readable by anyone with the URL even when the
  repository is private — the models and the full sensor layout are downloadable. If that needs
  locking down later, Cloudflare Pages with Cloudflare Access serves the same static files behind
  an email login on its free tier.

Paths are **case-sensitive** on Pages but not on Windows, so `Model-glb/` must stay spelled exactly
that way in `js/sites.js`.

## Configuring bridges

Everything site-specific lives in [`js/sites.js`](js/sites.js) — one entry per bridge:

| field | meaning |
| --- | --- |
| `name` | what the picker shows. Pre-filled with the code; **edit this**. Thai is fine. |
| `file` | path to the GLB, case-sensitive |
| `sizeMB`, `captured` | shown in the picker so you know what you are about to download |
| `northOffsetDeg` | true bearing of the model's &minus;Z axis. `0` means "not surveyed" |

Nothing else is per-bridge. Equipment is found in the model itself.

## The three sensor types

| Panel entry | What it is | How it is found |
| --- | --- | --- |
| **AXLE DETECTOR** | Benewake TF03-100 LiDAR, 4 per bridge | node named `TF03-100 LiDAR-R004` |
| **CAMERA** | Axis Q16 series, 2 per bridge | node named `AxisCam_Q16O#<n>` |
| **WEIGHT SENSOR** | strain plates on the girders, plus the uPVC conduit run that wires them | geometric, see below |

Three things worth knowing before editing `js/sensors.js`:

- Node names are matched on a **punctuation-stripped key**. GLTFLoader rewrites names on import
  (`TF03-100 LiDAR-R004` arrives as `TF03-100_LiDAR-R004`), and the camera instance number differs
  per site (`#2` on four sites, `#3` on BRC).
- **The strain gauges are not named.** Nothing in any of the five models is called "strain" or
  "WeightSensor", so they are found by shape and position: ~150 mm plates with mounting studs, at
  girder level, ~2 m apart across the deck, in two cross-sections near midspan. Every threshold
  sits in the `STRAIN` block at the top of `js/sensors.js` — that is the one place to adjust if a
  re-export moves things. Current results: 12 sensors on SSW, TPA and BRC, 16 on BKT, 14 on
  PM1-BWK. Detection is logged to the console on every load, so it can be checked against the
  model.
  If a future export names the plates, replace the whole `findStrainPlates()` heuristic with a name
  match like the other two types.
- The **conduit** is the opposite — completely reliable. Every piece has `conduit upvc` in its node
  name (195–328 meshes per model). The `VBO_Pipe` material only covers 5–19 fittings, so match on
  the name, not the material.

**`260919_BKT.glb` has no camera geometry.** Both of its `AxisCam` nodes are empty placeholders
where the other four sites have 11 meshes each. Selecting CAMERA there flies to the mounting
position, highlights nothing, and says so. Worth asking for a re-export if the camera bodies are
meant to be there.

## How highlighting works

A 150 mm plate bolted to a girder web is invisible on a 130 m bridge from most angles, so:

- Highlighted meshes swap to **one shared flat-colour material per type** and move to
  `HIGHLIGHT_LAYER`. Swapping beats cloning — the weight group alone is 300–500 meshes, and the
  whole model has only 12–18 materials, so cloning would tint the bridge.
- Each frame draws the model on layer 0, a dim quad over it, then clears depth and draws layer 1.
  Equipment buried inside the structure still reads.

Axle detectors and cameras are physically small and spread far apart, so at a view that fits all of
them they show as small bright marks rather than recognisable devices. Pinch to zoom in. The weight
sensors read much better because sixteen of them plus the conduit form a visible line.

## Compass mode

Turns the view to follow the phone's heading.

- **Needs HTTPS.** Browsers block device orientation on plain `http://`, so it works on the
  deployed Pages site but not over `http://<lan-ip>:5501`. The app says so rather than failing
  silently.
- iOS asks permission the first time you tap **Compass**; that tap is the required user gesture.
- A phone with no magnetometer reports only a relative heading, which is useless here. The app
  detects that and stays on touch control.

**Alignment.** The models carry no georeferencing, so the app has to be told which way they face:

1. Tap **Compass**. The first reading calibrates against whatever you were already looking at, so
   the view does not jump.
2. If it is off, just **drag the view** until it matches what is in front of you — that
   re-calibrates. Or use the ±5° buttons.
3. The offset is saved per bridge in the browser.

Once a bridge has been aligned on site, copy the "Model north offset" value the panel shows into
that entry's `northOffsetDeg` in `js/sites.js`, and nobody has to calibrate it again.

`Follow tilt` additionally pitches the view with the phone. It is off by default and is only
accurate in portrait.

## Layout

```
index.html          markup and the three.js import map
css/app.css         mobile-first styling
js/sites.js         the 5 bridges - edit names and north offsets here
js/main.js          boot and wiring
js/viewer.js        renderer, camera, orbit, fly-to, framing, highlight overlay pass
js/sensors.js       equipment detection and highlighting
js/compass.js       device orientation to camera heading, calibration
js/ui.js            side panel, bridge picker, loader, toast
Model-glb/*.glb     the bridge models
```

three.js is pinned to **0.163.0** in the import map. The materials declare
`KHR_materials_pbrSpecularGlossiness`, which no current three.js reads; they fall back to the
`pbrMetallicRoughness` block every material also carries, so they render correctly. Bumping the
version changes nothing here.

Rendering is on demand — the loop only draws when something moved. These models are 1200–2100 draw
calls per frame, so that matters for phone battery. If a target phone still struggles, the next
lever is a build-time `gltf-transform optimize` pass to produce smaller models.

## Links and debugging

`?site=BKT` opens a bridge, `?site=BKT&type=weight` opens it with that type highlighted. The URL
updates as you go, so it can be sent to someone else.

`?debug=1` exposes `window.__bwim` with the viewer, the current site and the detected groups —
useful for checking detection from the console on a real model.
