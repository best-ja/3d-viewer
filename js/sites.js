/**
 * Bridge registry - the only file to edit when bridges, models, names or pier
 * numbers change.
 *
 * name           display name in the picker. Pre-filled with the code.
 *                Thai is fine: this file is UTF-8 and names are inserted with
 *                textContent, never innerHTML.
 * file           path to the GLB. CASE-SENSITIVE on GitHub Pages - it must
 *                match the folder on disk exactly ("Model-glb", not "model-glb").
 * northOffsetDeg true bearing, in degrees clockwise from north, of the model's
 *                -Z axis. **null means not surveyed** - 0 is a real bearing and
 *                must not be used as a placeholder, or the first compass fix
 *                would calibrate over it.
 *                Ignored entirely when the model carries an N/E/S/W compass
 *                rose, which is read directly; 260921_BKT_VE.glb has one. For
 *                bridges without a rose, compass mode still works via in-app
 *                calibration - once a bridge has been aligned on site, copy the
 *                value the app shows into here so every inspector gets it.
 * piers          FALLBACK pier name tags, used only when the model itself has
 *                no pier-named nodes. glTF has no text primitive, so SketchUp
 *                Text entities are dropped on export - but group and component
 *                names survive, so the real fix is to name each pier instance
 *                "Pier-02", "Pier-03" ... and re-export, after which this list
 *                is not needed. Use a hyphen, not "Pier_02" - a trailing
 *                underscore-number cannot be told apart from the suffix glTF
 *                exporters add when de-duplicating repeated names. Until then:
 *
 *                  { label: 'P13', at: 8.0 }
 *
 *                `at` is the chainage in metres along the deck's long axis in
 *                model coordinates (Z for every bridge except BRC, which runs
 *                along X). Loading a bridge logs a "pier hint" line to the
 *                console with the column chainages it can find - a starting
 *                point, but check them against the model. An empty list simply
 *                shows no tags.
 *
 * views          optional per-type camera overrides. The camera normally picks
 *                its own angle - it raycasts to the target and swings round
 *                until nothing is in the way - so this is only for when you
 *                want a particular shot:
 *
 *                  views: {
 *                    weight:  { flip: true },     // mirror across the deck
 *                    cabinet: { azimuth: 135 },   // pin the direction, degrees
 *                  }
 *
 *                Keys are the type keys: axle, camera, weight, cabinet. An
 *                explicit azimuth is taken as given and skips the automatic
 *                search, but still warns in the console if it looks into
 *                something.
 *
 * unitLabels     optional per-type unit names, in the order the units run along
 *                the deck. Loading a bridge logs every unit with its position,
 *                so you can see which name belongs where:
 *
 *                  unitLabels: {
 *                    axle:   ['A-01', 'A-02', 'A-03', 'A-04'],
 *                    camera: ['CAM-01', 'CAM-02'],
 *                  }
 *
 *                A list of the wrong length is ignored with a warning rather
 *                than mislabelling anything.
 */
export const SITES = [
    {
        code: 'SSW',
        name: 'SSW',                          // <- edit: display name
        file: 'Model-glb/260916_SSW.glb',
        sizeMB: 14.7,
        captured: '2026-09-16',
        northOffsetDeg: null,
        piers: [],                            // <- edit: [{ label: 'P13', at: 4.7 }, ...]
    },
    {
        code: 'TPA',
        name: 'TPA',                          // <- edit: display name
        file: 'Model-glb/260916_TPA.glb',
        sizeMB: 11.4,
        captured: '2026-09-18',
        northOffsetDeg: null,
        piers: [],
    },
    {
        code: 'BRC',
        name: 'BRC',                          // <- edit: display name
        file: 'Model-glb/260921_BRC_VE.glb',
        sizeMB: 9.8,
        captured: '2026-09-21',
        northOffsetDeg: null,
        piers: [],
    },
    {
        code: 'BKT',
        name: 'BKT',                          // <- edit: display name
        file: 'Model-glb/260921_BKT_VE.glb',
        sizeMB: 16.5,
        captured: '2026-09-21',
        northOffsetDeg: null,
        piers: [],
    },
    {
        code: 'PM1-BWK',
        name: 'PM1-BWK',                      // <- edit: display name
        file: 'Model-glb/260919_PM1-BWK.glb',
        sizeMB: 9.3,
        captured: '2026-09-19',
        northOffsetDeg: null,
        piers: [],
    },
];

export const getSite = code => SITES.find(s => s.code === code) || null;
