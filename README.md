# BMA BWIM System

A phone-first 3D viewer for the bridge weigh-in-motion installations. Pick a bridge, pick a sensor
type, and every unit of that type lights up on the model while the camera moves to a view that
shows them — for weight sensors, that means going under the deck and looking up at the girders.
Expand a type to fly to one individual unit, and collapse the panel to get the whole screen back.

It shows where equipment is. It records nothing and reports no readings.

There is a second page, **[`show.html`](show.html)** — an unattended display for the conference
room. See [The show screen](#the-show-screen).

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

Everything site-specific lives in [`js/sites.js`](js/sites.js) — one entry per bridge. For renaming
sensors and setting camera angles by hand, **[CONFIG.md](CONFIG.md) is the manual**; this section is
the summary.

| field | meaning |
| --- | --- |
| `name` | what the picker shows. Pre-filled with the code; **edit this**. Thai is fine. |
| `file` | path to the GLB, case-sensitive |
| `sizeMB`, `captured` | shown in the picker so you know what you are about to download |
| `northOffsetDeg` | true bearing of the model's &minus;Z axis. `0` means "not surveyed" |
| `piers` | pier name tags — see [Pier name tags](#pier-name-tags) |
| `views` | per-type camera overrides — see below |
| `unitLabels` | per-type unit names — see below |

Nothing else is per-bridge. Equipment is found in the model itself.

## The four sensor types

| Panel entry | What it is | Units | How it is found |
| --- | --- | --- | --- |
| **AXLE DETECTOR** | Benewake TF03-100 LiDAR, its Plate Axle and its housing | AXLE 1-4 | node `TF03-100 LiDAR-R004`, plus everything within 0.5 m of it |
| **CAMERA** | Axis Q16 series | CAM 1-2 | node `AxisCam_Q16O#<n>` |
| **WEIGHT SENSOR** | strain plates on the girders and slab soffit, plus the uPVC conduit that wires them | — | geometric, see below |
| **CAS / BTS** | the two cabinets and their ตู้ครอบ enclosure | — | nodes `CAS` and `BTS`, plus whatever is inside the enclosure |

Tapping a type highlights all of it; expanding a type and tapping a unit flies to that one unit.
WEIGHT SENSOR and CAS / BTS have no submenu: the weight array is 16–20 rows that would swamp a
phone and is the useful thing to see whole, and the two cabinets are 0.56 m apart and always looked
at together.

Each type also carries a **framing** — where the camera goes when you select it. Weight sensors and
CAS / BTS are viewed from under the deck looking up at the girders. Zooming to a single axle
detector comes in **over the carriageway**: the detectors are mounted on a ~1.85 m barrier whose
centre is only 0.2 m outboard of them, so approaching from outside — which every other raised view
does — puts the wall between the camera and the device. See the `roadside` note in `js/viewer.js`.

**The camera checks its own shot.** Having computed where to stand, it raycasts to the target and
counts anything bigger than 30 cm in the way; if something is, it swings round — 180°, ±45°, ±90°,
±135° — and then closes in to 60% and 45% of the fitted distance, taking the first clear angle. Under
a deck there is structure in every horizontal direction, so coming in *past* an obstruction is often
the only option. Whatever the equipment is mounted on, within 1.5 m of it, does not count as
blocking. This is what keeps BRC's CAM 1 and both bridges' cabinet views clear without per-site
tuning.

When you want a particular shot anyway, override it per bridge in `js/sites.js`:

```js
views: {
  weight:  { flip: true },      // mirror the approach across the deck
  cabinet: { azimuth: 135 },    // pin the horizontal direction, degrees
}
```

Keys are the type keys — `axle`, `camera`, `weight`, `cabinet` — and an override applies to both the
type view and its unit views. A pinned `azimuth` is taken as given and skips the automatic search,
but still warns in the console if it turns out to look into something.

An override can also name a single sensor, by the label you gave it or by its id, and can set
`elevation` and `distance` as well as `azimuth`:

```js
views: {
  axle:     { azimuth: 90 },                     // all four
  'A-02':   { azimuth: 210, elevation: 15 },     // …except this one
}
```

**Unit names** are configurable the same way. The nth name goes to the nth unit along the deck, and
the panel is then ordered *by name*:

```js
unitLabels: {
  axle:   ['A-01', 'A-02', 'A-03', 'A-04'],
  camera: ['CAM-01', 'CAM-02'],
}
```

Loading a bridge logs every unit with its position, so it is clear which name belongs where. A list
of the wrong length is ignored with a warning rather than mislabelling anything.

To find an angle rather than guess it: select the sensor, orbit until it looks right, and run
`bwimView()` in the browser console — it prints a line ready to paste into `views`. Full walkthrough
in [CONFIG.md](CONFIG.md).

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
  | B | 8 on the slab soffit, `y 3.1` | weight sensor |
  | C | 4 mid-deck, `y 3.6` | weight sensor |

  All three are weight sensors. The only plates that are not are the ones sitting on a detector,
  a camera or inside the cabinet, which are handed to those instead.

  `classifyPlates()` has the rules; every threshold is in the `STRAIN` block. One detail matters
  and is easy to undo by accident: cabinet hardware is identified by falling *inside the enclosure
  box*, not by a radius around the nameplate, because on SSW and BKT the cabinet sits in the middle
  of the strain array and any radius wide enough to catch its own plates also swallows real sensors.
  The enclosure box is in turn built from non-plate meshes only, or it feeds on what it should exclude.

  Current counts: 16 weight sensors on SSW and TPA, 20 on BKT, 18 on BRC and PM1-BWK (those two
  each carry two ambiguous strays). Detection is logged to the console on every load.
  If a future export names the plates, replace the heuristic with a name match like the other types.
- **The detector housing and Plate Axle sit outside the LiDAR node.** Highlighting the named node
  alone lights only the 44 mm device. In every model each detector has, within 8 cm of it, a
  0.22 × 0.22 × 0.27 m `M06_Steel_Smoke` housing and three small mounting plates, all outside the
  node; the nearest unrelated geometry is 0.63 m away, so `attachUnitShells()` sweeps them in with
  a 0.5 m radius.
- The **conduit** is the opposite — completely reliable. Every piece has `conduit upvc` in its node
  name (195–328 meshes per model). The `VBO_Pipe` material only covers 5–19 fittings, so match on
  the name, not the material.
- **The CAS/BTS capture excludes structural steel by section size.** Rolled sections are named
  `|L-75x75…`, `|-150x75…`, `|SHS-32x32…`; anything 50 mm or over is girder steel, anything smaller
  is what the enclosures on BRC, PM1-BWK and TPA are welded from. Match these on the **raw** name —
  `key()` strips the leading `|` and the hyphens, so a pattern written for it silently matches
  nothing, which is exactly how girder angles ended up highlighted on SSW and BKT.

## Pier name tags

Pier tags come from the model when the designer has named the pier groups, and from `js/sites.js`
when they have not. Either way they are shown by the **Piers** toggle in the side panel.

**From the model (preferred).** Any node whose name contains `Pier` or `ตอม่อ` becomes a tag at its
own position; columns within 3 m along the deck are merged into one pier line, so a pier built from
two columns gets one label rather than two. Nothing to configure.

There is a catch worth understanding, because it is what the models do today. glTF has **no text
primitive**, so SketchUp *Text* and *Dimension* entities are silently dropped on export — only group
and component **names** survive. And a component *definition* name is shared by every instance of
it, so TPA's four piers all arrive called `Pier`, and BRC's arrive as `Pier 9 ขาออก` repeated across
three locations. The app renders them as-is and warns in the console:

```
[piers] 4 pier lines but repeated labels (Pier). These are component definition names
shared by every instance - name each pier instance (Entity Info) to tell them apart.
```

**The fix is in SketchUp:** name each pier *instance* — `Pier-02`, `Pier-03` … — not just the
component definition. Use a hyphen, not `Pier_02`: a trailing underscore-number cannot be told apart
from the suffix glTF exporters add when de-duplicating repeated names, and would be stripped.

**Fallback.** For a bridge whose model names no piers, list them in `js/sites.js`:

```js
{ code: 'BKT', /* … */
  piers: [ { label: 'P13', at: 8.0 }, { label: 'P14', at: 33.0 } ] }
```

`at` is the chainage in metres along the deck's long axis in model coordinates — Z on every bridge
except BRC, which runs along X. Loading a bridge logs a `pier hint` line with the column chainages
it can find; a starting point, not an answer. A bridge with neither source shows no tags and the
toggle is disabled.

**An export can ship empty camera nodes.** `260919_BKT.glb` did — both its `AxisCam` nodes were
placeholders with no meshes — and it was re-exported as `260921_BKT_VE.glb` with the camera bodies
present. The app copes either way: the camera type takes its positions from the nodes, so selecting
CAMERA still flies to the mounting points, highlights whatever geometry exists, and warns in the
console plus a toast when there is none. Worth chasing a re-export if that warning ever appears.

## How highlighting works

A 150 mm plate bolted to a girder web is invisible on a 130 m bridge from most angles, so:

- Highlighted meshes swap to **one shared flat-colour material per type** and move to
  `HIGHLIGHT_LAYER`. Swapping beats cloning — the weight group alone is 300–500 meshes, and the
  whole model has only 12–18 materials, so cloning would tint the bridge.
- That material **must be `DoubleSide`**. Every material in these GLBs is `doubleSided`, and the
  Plate Axle is a zero-thickness plane; with three.js's default `FrontSide` it is culled from behind
  and the highlight silently disappears.
- The highlight draws over the structure, so it stays visible even when the equipment is buried —
  but the *context* around it does not, which is why the camera angle matters as much as the
  highlight. The suite raycasts from camera to detector on all 20 axle units to prove the line of
  sight is clear.
- Each frame draws the model on layer 0, a dim quad over it, then clears depth and draws layer 1.
  Equipment buried inside the structure still reads.

Cameras are physically small and spread far apart, so selecting the whole type shows them as small
bright marks rather than recognisable devices. That is what the per-unit submenus are for: tapping
**CAM 2** flies to that one unit at a few metres' stand-off. Axle detectors read better now that
their housing and Plate Axle are included, and the weight sensors read well at type level because
the whole array plus the conduit forms a visible line.

## Compass mode

Turns the view to follow the phone's heading.

- **Needs HTTPS.** Browsers block device orientation on plain `http://`, so it works on the
  deployed Pages site but not over `http://<lan-ip>:5501`. The app says so rather than failing
  silently.
- iOS asks permission the first time you tap **Compass**; that tap is the required user gesture.
- A phone with no magnetometer reports only a relative heading, which is useless here. The app
  detects that and stays on touch control.

**Alignment.** The app has to know which way the model faces. In order of preference:

1. **A compass rose in the model.** If the export contains four letter glyphs named `N`, `E`, `S`
   and `W`, the bearing is read straight off them — no calibration at all. `260921_BKT_VE.glb` has
   one, and it is the best thing your designer can add to the other four. The panel shows "from the
   model compass rose" when this is what is in use.
2. **A surveyed value** in `northOffsetDeg` in `js/sites.js`. `null` means *not surveyed*; do not
   use `0` as a placeholder, because 0° is a real bearing — BKT's rose gives exactly that — and the
   app would auto-calibrate over it.
3. **Calibrating on site.** With neither of the above, the first heading aligns to whatever you were
   already looking at, so the view does not jump. If it is off, **drag the view** until it matches
   what is in front of you, or use the ±5° buttons. The result is saved per bridge in the browser
   and takes precedence over both of the above, so an on-site correction is never overwritten.

Once a bridge has been aligned on site, copy the "Model north offset" value the panel shows into
that entry's `northOffsetDeg`, and nobody has to calibrate it again.

`Follow tilt` additionally pitches the view with the phone. It is off by default and is only
accurate in portrait.

## Layout

```
index.html          the inspector page - markup and the three.js import map
show.html           the conference-room display
css/app.css         mobile-first styling, and the palette both pages use
css/show.css        big-screen layout for show.html
js/sites.js         the 5 bridges - edit names, views and north offsets here
js/main.js          boot and wiring for index.html
js/show.js          boot, panels, render loop and cycle for show.html
js/model.js         loading a GLB and measuring it - shared by both pages
js/viewer.js        renderer, camera, orbit, fly-to, framing, highlight overlay pass
js/sensors.js       equipment detection and highlighting - shared by both pages
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

## The show screen

`show.html` is for the screen in the conference room. Open it, walk away, and it runs on its own:
one big panel featuring a bridge with its name over it, four small panels showing the ones coming
up. Every fourteen seconds the feature moves to the next bridge, so a full pass is a little over a
minute.

**AXLE DETECTOR, WEIGHT SENSOR and CAS / BTS are all lit at the same time**, each in its own
colour, with a legend under the bridge name giving the colour and the count for each. Cameras are
left out on purpose. Because everything is lit together, one camera move per bridge does the whole
job — there is no stepping between subsystems.

There is no splash screen and no progress bar. The layout appears straight away and each panel
fills in as its model lands, so nothing on screen ever looks like it is loading.

Everything worth changing is the `SHOW` block at the top of `js/show.js` — how long each bridge
holds, how fast the featured bridge turns against the ones waiting in the strip, how high the
camera rides, and how much bridge stays in frame around the equipment.

It needs no input, but for a presenter: **space** pauses, **left/right** step between bridges, and
**f** goes fullscreen. `?dwell=12000` overrides the pacing without editing anything.

### How it draws five bridges at once

There is one `<canvas>` and one WebGL context. The five panels are transparent boxes in a CSS grid
whose rectangles are read back with `getBoundingClientRect()`, and each is drawn into with
`setViewport`/`setScissor`. Five separate canvases would mean five contexts, five environment maps
and five render loops, with no way to spend the frame budget where it matters.

All five models stay resident — about 8 400 draw calls and 350 MB of GPU memory between them — so
the budget is spent deliberately: the big panel is redrawn every frame, the small ones take turns,
one per frame. That works because the renderer asks for `preserveDrawingBuffer`, so a panel that is
skipped keeps the pixels it had instead of flickering to black. A frame comes to roughly 2 500–3 400
draw calls, under twice what the inspector page already does on a phone.

If the machine driving the TV cannot keep up, the page notices and hands work back by itself, in
the order that costs the least to look at:

| level | frame cap | small panels | resolution |
| --- | --- | --- | --- |
| 0 | 60 fps | every frame | full |
| 1 | 30 fps | every frame | 1x |
| 2 | 30 fps | every third frame | 0.75x |

Level 2 is the only one that shows, because redrawing the strip less often is what makes its orbit
judder — which is also why the waiting bridges turn at 1.2°/s against the featured bridge's 3°/s,
so that whatever the cadence, the step between redraws stays too small to read. The page logs each
change of level to the console. `?quality=0` pins it at full.

The camera never has to see past anything, because the highlight pass clears the depth buffer: the
weight sensors and cabinets under the deck glow straight through it.

## Links and debugging

`?site=BKT` opens a bridge, `?site=BKT&type=weight` opens it with that type highlighted, and
`?site=BKT&type=axle&unit=axle-2` opens it on a single unit. The URL updates as you go, so it can be
sent to someone else.

`?debug=1` exposes `window.__bwim` with the viewer, the current site and the detected groups —
useful for checking detection from the console on a real model. On `show.html` the same flag
exposes `window.__show` with the renderer, the five bridges, the panels and the cycle state.
