# Configuring BMA BWIM System

Everything you can change by hand lives in one file: **[`js/sites.js`](js/sites.js)**. It is plain
JavaScript — edit it in any text editor, save, reload the page. There is no build step.

This manual covers the two things you will actually want to change:

- [Naming the sensors](#naming-the-sensors)
- [Setting the camera angle](#setting-the-camera-angle)

Everything else about a bridge — where the sensors are, how many there are — is read from the model
itself and needs no configuration.

---

## Naming the sensors

Axle detectors and cameras are numbered along the deck by default: `AXLE 1`…`AXLE 4`, `CAM 1`,
`CAM 2`. To use your own names, add `unitLabels` to that bridge:

```js
{
    code: 'BKT',
    // …
    unitLabels: {
        axle:   ['A-01', 'A-02', 'A-03', 'A-04'],
        camera: ['CAM-01', 'CAM-02'],
    },
},
```

**The names are assigned along the deck, then the list is sorted by name.** The first name in the
array goes to the first sensor from the low-chainage end of the bridge, the second to the next, and
so on — but the side panel shows them in name order. So if the real numbering runs against the deck
direction, write the names in deck order and the panel still reads correctly:

```js
axle: ['A-04', 'A-03', 'A-02', 'A-01'],   // panel shows A-01, A-02, A-03, A-04
```

### Which sensor is which?

Open the browser console (F12) and load the bridge. Every unit is listed with its position:

```
AXLE DETECTOR units (rename them per bridge with unitLabels in js/sites.js)
┌─────────┬──────────┬────────┬───────┬────────┐
│ id      │ label    │ x      │ y     │ z      │
├─────────┼──────────┼────────┼───────┼────────┤
│ axle-1  │ 'AXLE 1' │ -2.26  │ 4.2   │ 17.46  │
│ axle-2  │ 'AXLE 2' │ 13.62  │ 4.2   │ 17.46  │
└─────────┴──────────┴────────┴───────┴────────┘
```

Or just tap each one in the panel and watch where the camera goes.

Weight sensors and CAS / BTS have no individual names — they are always shown as a set.

---

## Setting the camera angle

When you tap a sensor type, or one sensor, the camera flies to it. **It picks the angle itself:** it
looks along the line it is about to use, and if a girder, barrier or crossbeam is in the way it
swings round and, if that is not enough, moves in closer until it has a clear shot.

You only need this section when you want a *particular* view instead.

### For a whole type

```js
{
    code: 'BRC',
    // …
    views: {
        weight:  { flip: true },       // approach from the other side of the deck
        cabinet: { azimuth: 135 },     // come in from the south-east
    },
},
```

Keys are the four type keys: `axle`, `camera`, `weight`, `cabinet`.

### For one sensor

Use the sensor's **name**, exactly as it appears in the panel:

```js
views: {
    axle:     { azimuth: 90 },                     // all four detectors
    'A-02':   { azimuth: 210, elevation: 15 },     // …except this one
    'CAM-01': { distance: 6 },                     // closer, angle unchanged
},
```

A sensor's own entry wins over its type's. You can also use the stable id (`'axle-2'`, `'cam-1'`)
if you would rather the setting survive a rename.

### The four fields

| field | unit | meaning |
| --- | --- | --- |
| `azimuth` | degrees | which side the camera stands on |
| `elevation` | degrees | how high it stands. Negative looks up from below |
| `distance` | metres | how far back it stands |
| `flip` | `true` | mirror the automatic choice to the other side of the deck |

Set only the fields you care about — the rest keep whatever the automatic choice worked out.

**Azimuth**, looking down on the bridge. `0°` puts the camera on the −Z side looking toward +Z:

```
                 0°
                  │
                  │
     270° ───────( )─────── 90°          ( ) = the sensor
                  │                       0° = −Z,  90° = +X
                  │
                180°
```

**Elevation**, from the side. `0°` is level with the sensor, `+90°` directly overhead, negative
below — which is what the weight sensors and cabinets use, looking up at the girder soffit:

```
            +45°  ·
                   ╲
      0° ·──────────( )
                   ╱
            −45°  ·
```

`flip` is different from the other three: it nudges the *automatic* choice to the opposite side and
lets it carry on checking for obstructions. `azimuth`, `elevation` and `distance` are taken as
given, and the automatic check is skipped — you asked for that shot, so you get it.

---

## Finding the angle you want

Do not guess the numbers. Read them off the app:

1. Open the bridge and tap the sensor you want to set up.
2. Drag and pinch until the view looks right.
3. Open the browser console (F12) and type:

   ```js
   bwimView()
   ```

4. It prints a line ready to paste:

   ```
   BKT · axle · A-02
   views: { 'A-02': { azimuth: 143, elevation: 22, distance: 7.5 } }
   ```

5. Paste that into the bridge's `views` block in `js/sites.js` and reload.

### Worked example

Say CAM-01 on BRC comes up too far away and facing the wrong way.

```js
// 1. Give the cameras real names.
unitLabels: { camera: ['CAM-01', 'CAM-02'] },
```

Reload, tap **CAMERA → CAM-01**, drag until you can see the housing properly, then:

```js
bwimView()
// BRC · camera · CAM-01
// views: { 'CAM-01': { azimuth: 312, elevation: 8, distance: 9.4 } }
```

```js
// 2. Paste it in.
views: {
    'CAM-01': { azimuth: 312, elevation: 8, distance: 9.4 },
},
```

Reload. CAM-01 now opens at that view every time, on every phone.

---

## When something is not right

Open the console — the app says what it did.

### "I changed it and nothing happened"

Reload and read the first two console lines. Every load prints what it read out of
`js/sites.js`:

```
[config] BRC from js/sites.js — unitLabels.axle, views.cabinet
```

If your setting is not named there, the browser never saw your edit — check you saved the
file, and that the `views` block is inside the right bridge's `{ ... }`.

Then tap the sensor and read the view line. A shot taken from your config says so:

```
[view] cabinet (configured: azimuth, elevation, distance) — azimuth 90°, elevation -12°, distance 12.0 m
```

Without the `(configured: ...)` part the app chose the angle itself, which means no entry
matched. For one sensor, the key must be the name **exactly** as the panel shows it.


| message | what it means |
| --- | --- |
| `[labels] BKT.unitLabels.axle has 3 name(s) but 4 unit(s) were detected - ignoring it` | The list length must match exactly. Nothing is renamed until it does. |
| `[view] camera / CAM-01 pinned to azimuth 312 but 2 object(s) block it` | Your angle looks into something. Pick another, or delete the entry and let it choose. |
| `[view] no clear angle for under; best of 24 tried still has 3 object(s) in the way` | It could not find a clean shot anywhere and used the least bad one. Usually means the sensors really are boxed in. |
| `[view] weight elevation clamped to stay above the ground` | An under-deck elevation was steep enough to put the camera below ground level, so it was pulled back up. |
| `[piers] 4 pier lines but repeated labels (Pier)` | The model names its pier *component*, not each pier. See [README](README.md#pier-name-tags). |

---

## Quick reference

```js
{
    code: 'BKT',                              // never change - used in links
    name: 'BKT',                              // shown in the picker. Thai is fine
    file: 'Model-glb/260921_BKT_VE.glb',      // case-sensitive on GitHub Pages
    sizeMB: 16.5,
    captured: '2026-09-21',

    northOffsetDeg: null,                     // null = not surveyed. Ignored if the
                                              // model has an N/E/S/W compass rose

    piers: [],                                // fallback pier tags, only used when
                                              // the model names none itself
                                              //   { label: 'P13', at: 8.0 }

    unitLabels: {                             // optional
        axle:   ['A-01', 'A-02', 'A-03', 'A-04'],
        camera: ['CAM-01', 'CAM-02'],
    },

    views: {                                  // optional
        weight:   { flip: true },
        'CAM-01': { azimuth: 312, elevation: 8, distance: 9.4 },
    },
}
```
