# BMA BWIM System

A phone-first 3D viewer for the bridge weigh-in-motion installations. It opens on the bridge
picker — nothing loads until you choose one — and from there a strip under the title bar lights the
sensor types. Tap as many as you want at once; each lights in its own colour and the camera moves
to a view that shows them all. Tap one type on its own and a second row appears for its individual
units. For anything under the deck the floor drops out of the way by itself, so you can get down
there and look up at the girders.

It shows where equipment is. It records nothing and reports no readings.

There is a second page, **[`show.html`](show.html)** — a display for the conference room that
runs itself but can be driven by hand. See [The show screen](#the-show-screen).

## Run it locally

Any static server works; the GLBs are fetched with `fetch`, so opening `index.html` from the
filesystem will not work.

```bash
python -m http.server 5501
# then http://localhost:5501/
```

VS Code Live Server is already configured for port 5501 in `.vscode/settings.json`.

To try it on a phone on the same Wi-Fi, use `http://<your-lan-ip>:5501/`.

## Deploy to GitHub Pages

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then **Settings ▸ Pages ▸ Deploy from a branch ▸ `main` / `(root)`**.

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

### An export can ship empty camera nodes

`260919_BKT.glb` did — both its `AxisCam` nodes were placeholders with no meshes — and it was
re-exported as `260921_BKT_VE.glb` with the camera bodies present. The app copes either way: the
camera type takes its positions from the nodes, so lighting CAMERA still flies to the mounting
points, highlights whatever geometry exists, and warns in the console plus a toast when there is
none. Worth chasing a re-export if that warning ever appears.

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

Cameras are physically small and spread far apart, so lighting the whole type shows them as small
bright marks rather than recognisable devices. That is what the unit row is for: tapping **CAM 2**
flies to that one unit at a few metres' stand-off. Axle detectors read better now that their
housing and Plate Axle are included, and the weight sensors read well at type level because the
whole array plus the conduit forms a visible line.

## The menu strip

The sensor menu used to be a sidebar, 148 px of a phone screen wide and full height — which is
where the bridge is. It is now one row under the title bar: the type chips scroll sideways if they
have to, and **All**, **Floor** and the collapse chevron sit outside the scroller so they are
always reachable. All four chips and the tail fit without scrolling at 390 px.

**Every chip is a toggle.** A touch screen has no modifier to hold, so there is nothing to make a
tap mean "add to the selection" rather than "replace it" — every tap toggles, and any number of
types can be lit at once. **All** lights everything, and clears everything when it is already on.
Clearing everything pulls back to the whole bridge, which is what the old **Overview** button did.

The camera follows what is lit. One type is framed the way it always was, from its own
`framing` — above the deck for axle detectors, underneath it for weight sensors and CAS/BTS. Two or
more are framed together, from off the side of the deck at about 12° above level. That angle is not
a guess: it is where the show screen's own camera fit settled for exactly this mix of content, with
the roadside cameras 5 m up and the strain plates below the deck. A higher angle flattens the
spread between them.

The unit row only appears when **exactly one** type is lit and it has more than one unit —
narrowing to a single unit has no meaning across two types.

## The floor

Every one of the five models includes the ground as a slab at the very bottom, and in an under-deck
shot it fills the lower half of the screen and pins the camera above it. The **Floor** button drops
it.

It is mostly automatic. Lighting WEIGHT SENSOR or CAS/BTS drops the floor on its own, because those
are the two types framed from under the deck; the button overrules that for the view you are in,
and changing what is lit hands control back to the rule. The rule reads off each type's `framing`
field rather than naming the types again, so a type framed `under` in future gets the behaviour
for free.

**The ground is found geometrically**, because every node in these exports is called `Geom3D_`. A
mesh counts as ground when its world box sits wholly below 15% of the model's height *and* covers
at least 10% of its horizontal footprint:

| site | ground | y range | share of footprint |
| --- | --- | --- | --- |
| BKT | 15.9 &times; 0.20 &times; 79.0 | 0.00 &ndash; 0.21 | 96% |
| BRC | 130.6 &times; 0.31 &times; 20.4 | &minus;0.31 &ndash; 0.00 | 99% |
| PM1-BWK | 35.6 &times; 2.40 &times; 93.0 | &minus;2.40 &ndash; 0.00 | 98% |
| SSW | 7.5 &times; 0.62 &times; 79.6 | &minus;0.62 &ndash; 0.00 | 87% |
| TPA | 18.1 &times; 0.65 &times; 81.0 | 0.00 &ndash; 0.65 | 91% |

PM1-BWK crosses a canal, so its ground is four meshes rather than one — the slab plus two 6.5
&times; 93 m asphalt strips at 17.8% each and the translucent-blue water sheet under them at 13.7%.
Take the slab alone there and the bridge floats over a hovering blue rectangle. The largest thing
that must *survive* is SSW's four 3.8 m pile caps at 2.1%, and nothing in any model falls between
those two figures, so the 10% cut has 1.8&times; of margin either side of it.

Hiding the floor also **removes the camera's ground guard**, which is the point. With the floor
shown, an under-deck shot keeps the eye at standing height on the ground surface; with it hidden
there is nothing left to be inside, so a configured angle is taken exactly as written. BKT's
`weight` view asks for elevation &minus;12 and had been silently clamped ever since it was
surveyed — it now arrives at &minus;12. The guard itself also got more accurate: it used to use
`bbox.min.y`, the *underside* of the slab, which on PM1-BWK is 2.4 m below the ground you would
actually be standing on.

## Layout

```
index.html          the inspector page - markup and the three.js import map
show.html           the conference-room display
css/app.css         mobile-first styling, and the palette both pages use
css/show.css        big-screen layout for show.html
js/sites.js         the 5 bridges - edit names and camera views here
js/main.js          boot and wiring for index.html
js/show.js          boot, panels, render loop and cycle for show.html
js/model.js         loading a GLB and measuring it - shared by both pages
js/viewer.js        renderer, camera, orbit, fly-to, framing, highlight overlay pass
js/sensors.js       equipment and ground detection, highlighting - shared by both pages
js/ui.js            menu strip, bridge picker, loader, toast
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

**All four types are lit at the same time** — AXLE DETECTOR, CAMERA, WEIGHT SENSOR and CAS / BTS —
each in its own colour, with a legend under the bridge name saying which is which. Because
everything is lit together, one camera move per bridge does the whole job: there is no stepping
between subsystems.

There is no splash screen and no progress bar. The layout appears straight away and each panel
fills in as its model lands, so nothing on screen ever looks like it is loading. A change of bridge
cross-dissolves — all five panels at once, including the captions — rather than dipping to black.

**Anyone can walk up and drive it.** Drag any panel to turn that bridge; tap one of the small
panels to bring it up on the big one, keeping whatever angle it was turned to. Any touch holds the
cycle for a minute so the display will not snatch a bridge away mid-sentence, then it carries on by
itself. Dragging turns and nothing else: the camera distance is fixed, so a bridge can never be
zoomed into something unrecognisable and left that way.

For a presenter there is also **space** to pause (the only state the screen announces),
**left/right** to step between bridges and **f** for fullscreen. `?dwell=12000` overrides the
pacing without editing anything.

Everything worth changing is the `SHOW` block at the top of `js/show.js` — how long each bridge
holds, how fast it turns, how high the camera rides, how much room is left around the equipment and
how far a drag turns it.

### What the camera frames, and why it never zooms

The shot is the union of everything lit, and nothing else. These decks are 80–130 m long while the
equipment sits in one weigh station, so fitting a whole model puts the camera 110 m back and the
sensors become specks. Including the two roadside cameras costs real width — they are mounted
23–41 m from the weigh station on four of the five bridges — which is why the shot is a run of
instrumented bridge rather than a close-up of hardware.

The distance is worked out **once per bridge** and then held. It has to be: the fit depends on how
much of the box lies along the view direction, and on a long bridge that term swings by 9 m as the
azimuth sweeps, which reads as the camera creeping in and out. Fixing it also decides how the fit
is taken — over the arc the orbit actually sweeps, not over the full circle, because the end-on fit
sits 45–60% further out than the broadside one and fitting the circle would hold every bridge at
its worst angle for the whole show. Turn a bridge past that arc by hand and it simply grows past
the edges of the panel, which is what a fixed distance should do.

Which side to stand on is searched for rather than assumed. Square across the deck is right four
times out of five; it is wrong on PM1-BWK, where the equipment spans 25 m *across* a 35 m wide
bridge and only 17 m along it, so the search turns the camera to look down the deck instead. The
deck broadside wins any tie within 5%, so the classic shot is only overruled when the layout really
argues for it.

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
judder — which is also why the waiting bridges turn at 0.8°/s against the featured bridge's 1.5°/s,
so that whatever the cadence, the step between redraws stays too small to read. The page logs each
change of level to the console. `?quality=0` pins it at full.

The camera never has to see past anything, because the highlight pass clears the depth buffer: the
weight sensors and cabinets under the deck glow straight through it. Every panel gets that second
pass, the strip included, and it is close to free — the camera is restricted to the highlight layer
for it, so it draws the few hundred lit meshes rather than the bridge's 1 200–2 100. Without it the
thumbnails show no sensors at all, since almost everything is mounted under the deck.

## Links and debugging

**Every visit starts at the picker**, a shared link included — the link pre-selects the bridge it
names and carries its view through the tap. `?site=BKT&type=weight,cabinet` marks BKT in the picker
and lights those two once you tap it; `?site=BKT&type=axle&unit=axle-2` opens on a single unit. Tap
a *different* bridge and the type and unit are dropped, since `?unit=axle-3` means nothing on
another model. The URL updates as you go, so it can be sent to someone else.

`?debug=1` exposes `window.__bwim` with the viewer, the current site, the detected groups, the
floor state and the selection functions — useful for checking detection from the console on a real
model. On `show.html` the same flag
exposes `window.__show` with the renderer, the five bridges, the panels and the cycle state.
