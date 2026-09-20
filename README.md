# Bridge Sensor Inspector

A phone-first 3D viewer for locating installed monitoring hardware on site. Pick a site, see
every LiDAR and camera highlighted on the structure, tap one for its exact position, and switch on
compass mode so the model turns to face the same way you do.

It is a **viewer only** — it locates and identifies hardware. It records nothing.

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

## Configuring sites

Everything site-specific lives in [`js/sites.js`](js/sites.js) — one entry per site:

| field | meaning |
| --- | --- |
| `name` | what the picker shows. Pre-filled with the code; **edit this**. Thai is fine. |
| `file` | path to the GLB, case-sensitive |
| `sizeMB`, `captured` | shown in the picker so an inspector knows what they are downloading |
| `northOffsetDeg` | true bearing of the model's &minus;Z axis. `0` means "not surveyed" |

Nothing else is per-site. Sensors are found in the model itself.

## How sensors are found

Every GLB is a SimLab export carrying the same node names for the installed hardware
(`TF03-100 LiDAR-R004` ×4, `AxisCam_Q16O#<n>` ×2). `js/sensors.js` walks the loaded scene and
matches those names, then derives IDs, chainage and side from the model bounding box — so a
re-export with hardware in new positions needs no code change.

Two details worth knowing if you touch that file:

- Node names are matched on a **punctuation-stripped key**. GLTFLoader rewrites names on import
  (`TF03-100 LiDAR-R004` arrives as `TF03-100_LiDAR-R004`), and the camera instance number differs
  per site (`#2` on four sites, `#3` on BRC).
- **`260919_BKT.glb` has no camera geometry.** Its two `AxisCam` nodes are empty placeholders —
  24 transform nodes, zero meshes — where the other four sites have 11 meshes each. The app copes:
  markers hang off the node position, and the detail card says so. It is worth asking for a
  re-export if the camera bodies are meant to be there.

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
3. The offset is saved per site in the browser.

Once a site has been aligned on site, copy the "Model north offset" value the panel shows into that
site's `northOffsetDeg` in `js/sites.js`, and every inspector gets it without calibrating.

`Follow tilt` additionally pitches the view with the phone. It is off by default and is only
accurate in portrait.

## Layout

```
index.html          markup and the three.js import map
css/app.css         mobile-first styling
js/sites.js         the 5 sites - edit names and north offsets here
js/main.js          boot and wiring
js/viewer.js        renderer, scenes, camera, orbit, fly-to, focus dim
js/sensors.js       detection from node names, markers, highlighting
js/compass.js       device orientation to camera heading, calibration
js/ui.js            picker, chips, bottom sheet, detail card
Model-glb/*.glb     the site models
```

three.js is pinned to **0.163.0** in the import map. The materials declare
`KHR_materials_pbrSpecularGlossiness`, which no current three.js reads; they fall back to the
`pbrMetallicRoughness` block every material also carries, so they render correctly. Bumping the
version changes nothing here.

Rendering is on demand — the loop only draws when something moved. These models are 1200–2100 draw
calls per frame, so that matters for phone battery. If a target phone still struggles, the next
lever is a build-time `gltf-transform optimize` pass to produce smaller models.

## Deep links

`?site=BKT` opens a site, `?site=BKT&sensor=LDR-03` opens it with that unit selected. The URL
updates as you go, so it can be sent to someone else.
