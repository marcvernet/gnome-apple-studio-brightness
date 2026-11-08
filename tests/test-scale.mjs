/* Tests for StudioScale: the perceived-brightness (gamma) mapping between
 * slider position and raw USB HID values, user clamps, and adoption of
 * values the display reports. */

import Gio from 'gi://Gio';

import {
    SLICES, PREAMBLE, BRIGHTNESS_SCALE_STUB, loadModule, ok, nearly, done,
} from './helpers.mjs';

const MIN = 400, MAX = 60000; // firmware range of the Studio Display

const mod = await loadModule(`
${PREAMBLE}
${SLICES.scaleSteps}
${SLICES.cliTimeout}
function spawn() {
    return Promise.resolve({ok: false, out: '', err: 'unused'});
}
${BRIGHTNESS_SCALE_STUB}
${SLICES.studioScale}
export {StudioScale};
`);

const settings = new Gio.Settings(
    {schema_id: 'org.gnome.shell.extensions.apple-studio-brightness'});

class FakeTarget {
    constructor() {
        this._debounceMs = 0;
        this.writes = [];
    }
    scheduleWrite(raw, changed) {
        this.writes.push(raw);
        changed?.(raw);
        return Promise.resolve(true);
    }
}

function newScale() {
    const lm = {get_monitors: () => [{get_display_name: () => 'Studio Display'}]};
    const target = new FakeTarget();
    const scale = new mod.StudioScale(lm, target, settings);
    scale.setRange(MIN, MAX);
    return [scale, target];
}

function resetSettings() {
    for (const key of ['min-brightness', 'max-brightness', 'brightness-curve', 'ignore-ambient'])
        settings.reset(key);
}

let scale, target;

// --- linear mapping (curve = 1) --------------------------------------------
resetSettings();
settings.set_double('brightness-curve', 1.0);
[scale] = newScale();
ok(scale.toRaw(0) === MIN, 'linear: bottom is firmware floor 400');
ok(scale.toRaw(1) === MAX, 'linear: top is 60000');
ok(scale.toRaw(0.5) === (MIN + MAX) / 2, 'linear: midpoint is arithmetic');
nearly(scale.toFloat(30200), 0.5, 1e-9, 'linear: inverse midpoint');

// --- gamma mapping (default curve) -----------------------------------------
resetSettings();
ok(settings.get_double('brightness-curve') === 2.2, 'curve defaults to 2.2');
[scale] = newScale();
ok(scale.toRaw(0) === MIN, 'gamma: bottom still hits the floor');
ok(scale.toRaw(1) === MAX, 'gamma: top still hits the ceiling');
// 0.5^2.2 * 59600 + 400 ~= 13377: the slider's midpoint is ~134 nits,
// not 302 nits — this is the fix for the "too bright at the bottom" bug.
nearly(scale.toRaw(0.5), 13377, 30, 'gamma: midpoint is ~22% of nits');
ok(scale.toRaw(0.5) < scale.toRaw(0.6), 'gamma: monotonic');
ok(scale.toRaw(0.05) < 600, 'gamma: first key press from bottom is tiny');
for (const v of [0, 0.05, 0.25, 0.5, 0.75, 0.9, 1])
    nearly(scale.toFloat(scale.toRaw(v)), v, 5e-4,
        `gamma: roundtrip at ${v}`);

// --- user clamps -------------------------------------------------------------
resetSettings();
settings.set_double('min-brightness', 0.25);
settings.set_double('max-brightness', 0.5);
[scale] = newScale();
ok(scale.toRaw(0) === scale.toRaw(0.25), 'bottom clamp respected');
ok(scale.toRaw(0.6) === scale.toRaw(1), 'top clamp respected');
ok(scale.toRaw(0) > MIN, 'bottom clamp lifts above the floor');
resetSettings();

// --- backlights-changed plumbing --------------------------------------------
;[scale, target] = newScale();
scale.value = 0.5;
scale.setBacklight(0.5);
ok(target.writes.length === 1 && target.writes[0] === scale.toRaw(0.5),
    'setBacklight writes the mapped raw value');

// --- slider is authoritative over the ALS bias -------------------------------
/* BrightnessManager passes abTarget + value - 0.5 to setBacklight; the scale
 * must ignore that so the slider's bottom can actually reach the floor. */
class FakeManager {
    constructor(dimming = false) {
        this.dimming = dimming;
        this.autoBrightnessTarget = 0.8;
    }
}
resetSettings();
;[scale, target] = newScale();
scale._manager = new FakeManager(false);
scale.value = 0.1;
scale.setBacklight(0.4); // the manager's ALS-biased target
ok(target.writes.length === 1 && target.writes[0] === scale.toRaw(0.1),
    'ALS bias ignored: slider position wins');
scale.setBacklight(0.0);
ok(target.writes.at(-1) === scale.toRaw(0.1),
    'slider at floor still writes to slider position, not abTarget - 0.5');

;[scale, target] = newScale();
scale._manager = new FakeManager(true); // dimming active
scale.value = 0.8;
scale.setBacklight(0.3); // idle-dim target (idle-brightness 30)
ok(target.writes[0] === scale.toRaw(0.3), 'idle dimming still caps brightness');

;[scale, target] = newScale();
scale._manager = new FakeManager(false);
scale._settings.set_boolean('ignore-ambient', false);
scale.value = 0.1;
scale.setBacklight(0.4);
ok(target.writes[0] === scale.toRaw(0.4),
    'ignore-ambient=false restores the manager-biased target');
scale._settings.reset('ignore-ambient');

// --- adoption of display-reported values ------------------------------------
resetSettings();
[scale] = newScale();
let notified = 0;
scale.connect('notify::value', () => notified++);
scale.adoptRaw(13377);
nearly(scale.value, 0.5, 0.005, 'adoptRaw inverts the gamma curve');
const valueAfter = scale.value;
scale.adoptRaw(13377);
ok(notified === 1, 'adoptRaw of the same value does not notify');
scale.adoptRaw(MIN);
ok(scale.value === 0, 'adoptRaw of the floor gives 0');
scale.adoptRaw(MAX + 1000);
ok(scale.value === 1, 'adoptRaw clamps above the ceiling');

// --- applyAls: the auto-brightness drive --------------------------------------
resetSettings();
;[scale, target] = newScale();
const alsMgr = {dimming: false, _inhibitUpdates: false};
scale._manager = alsMgr;
scale.value = 0.5;
ok(scale.applyAls(0.51) === false, 'applyAls within hysteresis does nothing');
ok(target.writes.length === 0, 'hysteresis: no panel write');
ok(scale.applyAls(0.8) === true, 'applyAls moves the slider');
nearly(scale.value, 0.8, 1e-9, 'applyAls sets the slider position');
ok(target.writes.length === 1 && target.writes[0] === scale.toRaw(0.8),
    'applyAls writes the panel directly');
ok(alsMgr._inhibitUpdates === false, 'applyAls restores _inhibitUpdates');
scale._bias = -0.25;
ok(scale.applyAls(0.8) === true, 'the offset moves the slider again');
nearly(scale.value, 0.55, 1e-9, 'applyAls applies the user offset');

done('test-scale');
