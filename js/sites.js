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
 *                -Z axis. 0 means "not surveyed yet". Compass mode works
 *                without it via in-app calibration; once a bridge has been
 *                calibrated on site, copy the value the app shows into here so
 *                every inspector gets it for free.
 * piers          pier name tags, shown by the Piers toggle in the side panel.
 *                Pier numbers are NOT in the model files - three of the five
 *                have no pier nodes at all, and the two that do reuse the same
 *                component name across several locations - so they have to be
 *                listed here to be correct.
 *
 *                  { label: 'P13', at: 8.0 }
 *
 *                `at` is the chainage in metres along the deck's long axis in
 *                model coordinates (Z for every bridge except BRC, which runs
 *                along X). Loading a bridge logs a "pier hint" line to the
 *                console with the column chainages it can find - a starting
 *                point, but check them against the model. An empty list simply
 *                shows no tags.
 */
export const SITES = [
    {
        code: 'SSW',
        name: 'SSW',                          // <- edit: display name
        file: 'Model-glb/260916_SSW.glb',
        sizeMB: 14.7,
        captured: '2026-09-16',
        northOffsetDeg: 0,
        piers: [],                            // <- edit: [{ label: 'P13', at: 4.7 }, ...]
    },
    {
        code: 'TPA',
        name: 'TPA',                          // <- edit: display name
        file: 'Model-glb/260916_TPA.glb',
        sizeMB: 11.4,
        captured: '2026-09-18',
        northOffsetDeg: 0,
        piers: [],
    },
    {
        code: 'BRC',
        name: 'BRC',                          // <- edit: display name
        file: 'Model-glb/260918_BRC.glb',
        sizeMB: 12.6,
        captured: '2026-09-18',
        northOffsetDeg: 0,
        piers: [],
    },
    {
        code: 'BKT',
        name: 'BKT',                          // <- edit: display name
        file: 'Model-glb/260919_BKT.glb',
        sizeMB: 16.0,
        captured: '2026-09-19',
        northOffsetDeg: 0,
        piers: [],
    },
    {
        code: 'PM1-BWK',
        name: 'PM1-BWK',                      // <- edit: display name
        file: 'Model-glb/260919_PM1-BWK.glb',
        sizeMB: 9.3,
        captured: '2026-09-19',
        northOffsetDeg: 0,
        piers: [],
    },
];

export const getSite = code => SITES.find(s => s.code === code) || null;
