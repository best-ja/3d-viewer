/**
 * Site registry - the only file to edit when sites, models or names change.
 *
 * name           display name in the picker. Pre-filled with the code.
 *                Thai is fine: this file is UTF-8 and names are inserted with
 *                textContent, never innerHTML.
 * file           path to the GLB. CASE-SENSITIVE on GitHub Pages - it must
 *                match the folder on disk exactly ("Model-glb", not "model-glb").
 * northOffsetDeg true bearing, in degrees clockwise from north, of the model's
 *                -Z axis. 0 means "not surveyed yet". Compass mode works
 *                without it via in-app calibration; once a site has been
 *                calibrated on site, copy the value the app shows into here so
 *                every inspector gets it for free.
 */
export const SITES = [
    {
        code: 'SSW',
        name: 'SSW',                          // <- edit: display name
        file: 'Model-glb/260916_SSW.glb',
        sizeMB: 14.7,
        captured: '2026-09-16',
        northOffsetDeg: 0,
    },
    {
        code: 'TPA',
        name: 'TPA',                          // <- edit: display name
        file: 'Model-glb/260916_TPA.glb',
        sizeMB: 11.4,
        captured: '2026-09-18',
        northOffsetDeg: 0,
    },
    {
        code: 'BRC',
        name: 'BRC',                          // <- edit: display name
        file: 'Model-glb/260918_BRC.glb',
        sizeMB: 12.6,
        captured: '2026-09-18',
        northOffsetDeg: 0,
    },
    {
        code: 'BKT',
        name: 'BKT',                          // <- edit: display name
        file: 'Model-glb/260919_BKT.glb',
        sizeMB: 16.0,
        captured: '2026-09-19',
        northOffsetDeg: 0,
    },
    {
        code: 'PM1-BWK',
        name: 'PM1-BWK',                      // <- edit: display name
        file: 'Model-glb/260919_PM1-BWK.glb',
        sizeMB: 9.3,
        captured: '2026-09-19',
        northOffsetDeg: 0,
    },
];

export const getSite = code => SITES.find(s => s.code === code) || null;
