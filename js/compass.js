/**
 * Compass mode - point the 3D view the same way the phone is pointing.
 *
 * Heading sources, in order of preference:
 *   1. event.webkitCompassHeading  (iOS, already degrees clockwise from north)
 *   2. deviceorientationabsolute   (Android/Chrome, heading = 360 - alpha)
 *   3. deviceorientation with absolute === true
 * A plain relative `deviceorientation` is useless for this - the alpha zero
 * point is wherever the phone happened to be - so we detect it and say so
 * rather than silently drifting.
 *
 * Alignment: `northOffset` is the true bearing of the model's -Z axis. It is
 * unknown for a fresh site, so the first heading after switching the mode on
 * calibrates from whatever the inspector was already looking at, and dragging
 * the view at any time re-calibrates. Both are persisted per site.
 */
import * as THREE from 'three';

const STORE_PREFIX = 'bsi.north.';
const DEG = Math.PI / 180;

/** Smoothing time constant, seconds. Magnetometers are noisy enough that the
 *  model shivers without this. Applied per elapsed time rather than per frame,
 *  so tracking feels the same on a phone rendering 15fps and one doing 60. */
const SMOOTH_TAU = 0.12;

const screenAngle = () => (screen.orientation && screen.orientation.angle) || window.orientation || 0;

function headingFrom(e) {
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
        return { deg: e.webkitCompassHeading, absolute: true };
    }
    if (typeof e.alpha !== 'number' || Number.isNaN(e.alpha)) return null;
    return { deg: (360 - e.alpha) % 360, absolute: e.absolute === true };
}

function tiltFrom(e) {
    const beta = e.beta ?? 0, gamma = e.gamma ?? 0;
    switch (screenAngle()) {
        case 90:  return -gamma;
        case 180: return 90 - beta;
        case 270: return gamma;
        default:  return beta - 90;     // portrait: 90 = held upright
    }
}

/** Shortest signed distance from angle a to angle b, in radians. */
function angleDelta(a, b) {
    return ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}
const lerpAngle = (a, b, t) => a + angleDelta(a, b) * t;

export function createCompass(viewer, { onStatus, onReading }) {
    const { camera, controls } = viewer;

    const available = typeof DeviceOrientationEvent !== 'undefined';
    const needsPermission = available && typeof DeviceOrientationEvent.requestPermission === 'function';

    let active = false;
    let siteCode = null;
    let siteDefault = 0;
    let northOffset = 0;         // degrees, bearing of the model -Z axis
    let heading = null;          // degrees clockwise from north
    let tilt = 0;                // degrees, + = looking up
    let absolute = false;
    let tiltEnabled = false;
    let dragging = false;
    let firstFix = true;
    let listening = false;
    let waitTimer = null;
    let hasStoredOffset = false;
    let surveyed = false;        // the offset came from the model or from config

    let smoothTheta = null, smoothPhi = null, lastFrame = 0;

    const storeKey = () => STORE_PREFIX + siteCode;
    const status = (state, detail) => onStatus && onStatus(state, detail);

    /* ---------- orbit helpers (we drive the camera directly so pinch-zoom
                  and pan keep working while the heading owns the azimuth) --- */
    const off = new THREE.Vector3();

    function currentSpherical() {
        off.copy(camera.position).sub(controls.target);
        const r = off.length();
        return { r, theta: Math.atan2(off.x, off.z), phi: Math.acos(THREE.MathUtils.clamp(off.y / r, -1, 1)) };
    }

    function placeCamera(r, theta, phi) {
        camera.position.set(
            controls.target.x + r * Math.sin(phi) * Math.sin(theta),
            controls.target.y + r * Math.cos(phi),
            controls.target.z + r * Math.sin(phi) * Math.cos(theta),
        );
        camera.lookAt(controls.target);
    }

    /** Azimuth the model must sit at for the view to face compass bearing h. */
    const thetaFor = h => (northOffset - h) * DEG;

    function saveOffset() {
        if (!siteCode) return;
        try { localStorage.setItem(storeKey(), String(northOffset)); } catch { /* private mode */ }
    }

    function setNorthOffset(deg) {
        northOffset = ((deg % 360) + 360) % 360;
        saveOffset();
        emit();
    }

    /** Re-derive the offset so the current view lines up with the current heading. */
    function alignToCurrentView() {
        if (heading == null) return false;
        const { theta } = currentSpherical();
        setNorthOffset(theta / DEG + heading);
        smoothTheta = theta;
        return true;
    }

    const emit = () => onReading && onReading({
        heading, tilt, absolute, northOffset, active,
        source: hasStoredOffset ? 'saved' : (surveyed ? 'model' : 'unset'),
    });

    /* ---------- sensor plumbing ---------- */
    function onOrientation(e) {
        const h = headingFrom(e);
        if (!h) return;
        if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }

        if (!h.absolute && !absolute) {
            // Relative-only: no magnetometer, or the browser withheld it.
            stop();
            status('relative');
            return;
        }
        absolute = true;
        heading = ((h.deg + screenAngle()) % 360 + 360) % 360;
        tilt = tiltFrom(e);

        if (firstFix) {
            firstFix = false;
            status('ok');
            // No surveyed bearing for this bridge - start tracking from
            // whatever the inspector was already looking at, so the view does
            // not jump the moment the mode is switched on. A surveyed offset is
            // never auto-calibrated over, including a legitimate 0.
            if (!hasStoredOffset && !surveyed) alignToCurrentView();
            else smoothTheta = thetaFor(heading);
        }
        emit();
        viewer.invalidate();
    }

    function attach() {
        if (listening) return;
        listening = true;
        addEventListener('deviceorientationabsolute', onOrientation, true);
        addEventListener('deviceorientation', onOrientation, true);
    }
    function detach() {
        if (!listening) return;
        listening = false;
        removeEventListener('deviceorientationabsolute', onOrientation, true);
        removeEventListener('deviceorientation', onOrientation, true);
    }

    async function start() {
        if (!available) { status('unsupported'); return false; }
        if (!isSecureContext) { status('insecure'); return false; }

        if (needsPermission) {
            let res;
            try { res = await DeviceOrientationEvent.requestPermission(); }
            catch { status('denied'); return false; }
            if (res !== 'granted') { status('denied'); return false; }
        }

        active = true;
        firstFix = true;
        absolute = false;
        heading = null;
        smoothTheta = null;
        smoothPhi = null;
        lastFrame = 0;
        controls.enableRotate = true;      // dragging re-calibrates, see below
        attach();
        status('waiting');
        waitTimer = setTimeout(() => { if (firstFix) { stop(); status('no-data'); } }, 3000);
        emit();
        return true;
    }

    function stop() {
        if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
        detach();
        active = false;
        emit();
        viewer.invalidate();
    }

    // Dragging the view while tracking re-calibrates: whatever they drag to
    // becomes the new alignment. Guarded on the azimuth actually changing, so a
    // pinch-zoom or a pan does not quietly rewrite the offset.
    let dragTheta = 0;
    controls.addEventListener('start', () => { dragging = true; dragTheta = currentSpherical().theta; });
    controls.addEventListener('end', () => {
        if (dragging && active && heading != null && Math.abs(angleDelta(dragTheta, currentSpherical().theta)) > 0.02) {
            alignToCurrentView();
        }
        dragging = false;
    });

    /* ---------- per-frame camera drive ---------- */
    viewer.onFrame(t => {
        if (!active || heading == null || dragging || viewer.isFlying()) { lastFrame = 0; return false; }

        // Clamped so a long pause (backgrounded tab, stalled frame) does not
        // snap the view round in one step.
        const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 1 / 60;
        lastFrame = t;

        const { r, theta, phi } = currentSpherical();
        const wantTheta = thetaFor(heading);
        const wantPhi = tiltEnabled
            ? THREE.MathUtils.clamp(Math.PI / 2 + tilt * DEG, 0.18, Math.PI - 0.18)
            : phi;

        if (smoothTheta === null) smoothTheta = theta;
        if (smoothPhi === null) smoothPhi = phi;

        const k = 1 - Math.exp(-dt / SMOOTH_TAU);
        smoothTheta = lerpAngle(smoothTheta, wantTheta, k);
        smoothPhi = smoothPhi + (wantPhi - smoothPhi) * k;

        if (Math.abs(angleDelta(theta, smoothTheta)) < 1e-4 && Math.abs(smoothPhi - phi) < 1e-4) return false;

        placeCamera(r, smoothTheta, smoothPhi);
        return true;
    });

    return {
        available,
        get secure() { return isSecureContext; },
        get active() { return active; },
        get heading() { return heading; },
        get northOffset() { return northOffset; },
        get tiltEnabled() { return tiltEnabled; },
        get surveyed() { return surveyed; },

        /** @param defaultDeg bearing of the model -Z axis, or null if unknown.
         *  @param isSurveyed true when that bearing is real (model compass rose
         *         or a configured value) rather than an unset placeholder. */
        setSite(code, defaultDeg = null, isSurveyed = false) {
            siteCode = code;
            surveyed = !!isSurveyed && Number.isFinite(defaultDeg);
            siteDefault = Number.isFinite(defaultDeg) ? defaultDeg : 0;
            let stored = null;
            try { stored = localStorage.getItem(STORE_PREFIX + code); } catch { /* private mode */ }
            hasStoredOffset = stored !== null && stored !== '';
            northOffset = hasStoredOffset ? Number(stored) : siteDefault;
            if (!Number.isFinite(northOffset)) northOffset = siteDefault;
            smoothTheta = null;
            firstFix = true;
            emit();
        },
        setTiltEnabled(on) { tiltEnabled = !!on; smoothPhi = null; viewer.invalidate(); },
        setNorthOffset,
        nudge(deg) { setNorthOffset(northOffset + deg); smoothTheta = null; viewer.invalidate(); },
        resetOffset() {
            try { localStorage.removeItem(storeKey()); } catch { /* private mode */ }
            hasStoredOffset = false;
            northOffset = siteDefault;
            smoothTheta = null;
            if (active && heading != null) alignToCurrentView();
            emit();
            viewer.invalidate();
        },
        alignToCurrentView,
        start, stop,
    };
}
