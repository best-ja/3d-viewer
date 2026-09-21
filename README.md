# BMA BWIM System

A phone-first 3D viewer for the bridge weigh-in-motion installations. Pick a bridge, pick a sensor
type, and every unit of that type lights up on the model while the camera moves to a view that
shows them — for weight sensors, that means going under the deck and looking up at the girders.
Expand a type to fly to one individual unit, and collapse the panel to get the whole screen back.

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
| `piers` | pier name tags — see [Pier name tags](#pier-name-tags) |

Nothing else is per-bridge. Equipment is found in the model itself.

## The four sensor types

| Panel entry | What it is | Units | How it is found |
| --- | --- | --- | --- |
| **AXLE DETECTOR** | Benewake TF03-100 LiDAR + its Plate Axle | AXLE 1-4 | node `TF03-100 LiDAR-R004`, plus plates at the same chainage |
| **CAMERA** | Axis Q16 series | CAM 1-2 | node `AxisCam_Q16O#<n>` |
| **WEIGHT SENSOR** | strain plates on the girders and slab soffit, plus the uPVC conduit that wires them | — | geometric, see below |
| **CAS / BTS** | the two cabinets and their ตู้ครอบ enclosure | CAS, BTS | nodes `CAS` and `BTS`, plus whatever is inside the enclosure |

Tapping a type highlights all of it; expanding a type and tapping a unit flies to that one unit.
WEIGHT SENSOR has no submenu — 12–16 rows would swamp a phone, and the array is the useful thing
to look at anyway.

Things worth knowing before editing `js/sensors.js`:

- Node names are matched on a **punctuation-stripped key**. GLTFLoader rewrites names on import
  (`TF03-100 LiDAR-R004` arrives as `TF03-100_LiDAR-R004`), and the camera instance number differs
  per site (`#2` on four sites, `#3` on BRC).
- **The plates are not named.** Nothing in any model is called "strain", "plate", "ตู้" or "ครอบ",
  so the 150 mm plates are found by shape and then sorted by where they sit. They fall into three
  families, consistently across all five models (BKT shown):

  | band | where | what it is |
  | --- | --- | --- |
  | A | 8 on the girder bottom flanges, `y 2.5` | weight sensor |
  | B | 8 higher up / on the slab soffit, `y 3.1` | weight sensor |
  | C | 4 mid-deck, at the axle-detector chainages, `y 3.6` | **Plate Axle** |

  `classifyPlates()` has the rules; every threshold is in the `STRAIN` block. Two ordering details
  matter and are easy to undo by accident: the axle-chainage test runs *before* any bracket test,
  because on SSW a real Plate Axle sits 1.48 m from its own detector; and cabinet hardware is
  identified by falling *inside the enclosure box*, not by a radius around the nameplate, because
  on SSW and BKT the cabinet sits in the middle of the strain array.

  Current counts: 12 weight sensors on SSW and TPA, 16 on BKT, 14 on BRC and PM1-BWK (those two
  each carry two ambiguous strays). Detection is logged to the console on every load.
  If a future export names the plates, replace the heuristic with a name match like the other types.
- The **conduit** is the opposite — completely reliable. Every piece has `conduit upvc` in its node
  name (195–328 meshes per model). The `VBO_Pipe` material only covers 5–19 fittings, so match on
  the name, not the material.

## Pier name tags

Pier numbers are **not in the model files** — three of the five have no pier nodes at all, and the
two that do reuse the same component name across several locations. So they are listed per bridge
in `js/sites.js` and shown with the **Piers** toggle in the side panel:

```js
{ code: 'BKT', /* … */
  piers: [ { label: 'P13', at: 8.0 }, { label: 'P14', at: 33.0 } ] }
```

`at` is the chainage in metres along the deck's long axis in model coordinates — Z on every bridge
except BRC, which runs along X. Loading a bridge logs a `pier hint` line with the column chainages
it can find; that is a starting point, not an answer, so check it against the model. A bridge with
an empty list shows no tags and the toggle is disabled.

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

Axle detectors and cameras are physically small and spread far apart, so selecting the whole type
shows them as small bright marks rather than recognisable devices. That is what the per-unit
submenus are for: tapping **AXLE 2** flies to that one detector at a few metres' stand-off. The
weight sensors read well at type level because sixteen of them plus the conduit form a visible line.

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

`?site=BKT` opens a bridge, `?site=BKT&type=weight` opens it with that type highlighted, and
`?site=BKT&type=axle&unit=axle-2` opens it on a single unit. The URL updates as you go, so it can be
sent to someone else.

`?debug=1` exposes `window.__bwim` with the viewer, the current site and the detected groups —
useful for checking detection from the console on a real model.
