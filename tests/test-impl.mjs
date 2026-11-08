/* Integration tests for Impl: scale injection into a (mock)
 * BrightnessManager, monitors-changed reinjection, teardown on disable,
 * and the no-OSD-flash adoption path. The shell modules (Main,
 * BrightnessScale) are replaced by mocks; everything else is the real code.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    SLICES, PREAMBLE, BRIGHTNESS_SCALE_STUB, loadModule, reloadModuleTwice,
    ok, nearly, done,
} from './helpers.mjs';

const RAW_NOW = 16200, RAW_MIN = 400, RAW_MAX = 60000;

const IMPL_SRC = `
${PREAMBLE}
${SLICES.scaleSteps}
${SLICES.cliTimeout}
export const setCalls = [];
export const alsCalls = [];
export const als = {out: 'raw=1000 scale=1.0 lux=1000.0'};
function spawn(argv) {
    if (argv[1] === 'als') {
        alsCalls.push(als.out);
        return Promise.resolve({ok: true, out: als.out, err: null});
    }
    if (argv[1] === 'set')
        setCalls.push(argv[2]);
    const out = 'brightness: 27% raw=${RAW_NOW} min=${RAW_MIN} max=${RAW_MAX} hidraw=/dev/hidraw8';
    return Promise.resolve({ok: true, out, err: null});
}
${BRIGHTNESS_SCALE_STUB}
const FakeBrightnessManager = GObject.registerClass({
    GTypeName: 'FakeBrightnessManager_' + GLib.get_real_time().toString(36),
    Signals: {'changed': {}, 'user-update': {}},
}, class extends GObject.Object {
    _init() {
        this._monitorScales = new Map();
        this._globalScale = null;
        this._inhibitUpdates = false;
        this._scaleChanged = false;
        this._syncCount = 0;
        super._init();
    }
    _sync(_opts) {
        this._syncCount++;
    }
});
const manager = new FakeBrightnessManager();
const Main = {brightnessManager: manager};
${SLICES.usbTarget}
${SLICES.studioScale}
${SLICES.impl}
export {StudioScale, manager};
`;

const mod = await loadModule(IMPL_SRC);

const {manager} = mod;

const mm = {
    _cb: null,
    get_logical_monitors: () => [{
        get_monitors: () => [{
            is_active: () => true,
            get_vendor: () => 'APP',
            get_product: () => 'StudioDisplay',
            get_connector: () => 'DP-2',
            get_display_name: () => 'Studio Display',
        }],
    }],
    connect(_sig, cb) {
        this._cb = cb;
        return 1;
    },
    disconnect() {
        this._cb = null;
    },
};
globalThis.backend = {get_monitor_manager: () => mm};

async function waitFor(cond, what, timeoutMs = 3000) {
    const deadline = GLib.get_real_time() + timeoutMs * GLib.TIME_SPAN_MILLISECOND;
    while (!cond()) {
        if (GLib.get_real_time() > deadline)
            throw new Error(`timeout waiting for ${what}`);
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10,
            () => (r(), GLib.SOURCE_REMOVE)));
    }
}

const settings = new Gio.Settings(
    {schema_id: 'org.gnome.shell.extensions.apple-studio-brightness'});
settings.set_int('poll-interval-secs', 0); // no polling in tests
settings.set_double('brightness-curve', 1.0); // deterministic adopt check

let userUpdates = 0;
manager.connect('user-update', () => userUpdates++);

// --- enable injects a scale -------------------------------------------------
const impl = new mod.Impl(settings, '/nonexistent-extension-dir');
await impl.enable();
await waitFor(() => manager._monitorScales.size === 1, 'scale injection');

const scale = manager._monitorScales.values().next().value;
ok(scale instanceof mod.StudioScale, 'injected scale is a StudioScale');
ok(manager._globalScale !== null, 'global scale created');
nearly(scale.value, (RAW_NOW - RAW_MIN) / (RAW_MAX - RAW_MIN), 0.005,
    'initial value adopted from the display');
ok(userUpdates === 0, 'initial adoption does not emit user-update (no OSD)');
ok(manager._syncCount > 0, 'injection triggered a manager _sync');

// --- slider move drives _sync and user-update --------------------------------
const syncBefore = manager._syncCount;
scale.value = 0.25;
ok(manager._syncCount > syncBefore, 'slider move triggers _sync');
ok(userUpdates >= 1, 'slider move emits user-update');

// --- gamma applied on write ---------------------------------------------------
/* The slider position is authoritative (setBacklight ignores the manager's
 * argument unless dimming), so drive it the way BrightnessManager does. */
settings.set_double('brightness-curve', 2.2);
scale.value = 1.0;
scale.setBacklight(1.0);
scale.value = 0.5;
scale.setBacklight(0.5); // coalesced: only the newest raw value is written
await waitFor(() => mod.setCalls.length > 0, 'gamma write lands');
ok(mod.setCalls.length === 1 && mod.setCalls[0] === String(scale.toRaw(0.5)),
    'burst coalesced to the newest gamma-mapped raw value');
nearly(parseInt(mod.setCalls[0], 10), 13372, 30, '0.5 under gamma 2.2 is ~134 nits');
settings.set_double('brightness-curve', 1.0);

// --- monitors-changed re-injects ---------------------------------------------
mm._cb(); // fire the monitors-changed handler
await waitFor(() => manager._monitorScales.size === 1,
    'reinject after monitors-changed');
ok(manager._monitorScales.values().next().value instanceof mod.StudioScale,
    're-injected scale is fresh');

// --- disable tears everything down -------------------------------------------
impl.disable();
ok(manager._monitorScales.size === 0, 'disable clears _monitorScales');
ok(manager._globalScale === null, 'disable drops the global scale');
ok(mm._cb === null, 'disable disconnects monitors-changed');

// --- a second enable/disable cycle works (hot-reload path) --------------------
const impl2 = new mod.Impl(settings, '/nonexistent-extension-dir');
await impl2.enable();
await waitFor(() => manager._monitorScales.size === 1, 'second enable');
impl2.disable();
ok(manager._monitorScales.size === 0, 'second disable cleans up');

// --- ALS auto-brightness (the display's own light sensor) --------------------
settings.set_double('als-bias', 0.0);
settings.set_boolean('auto-brightness', true);
// Pin the lux range so the expectations below do not drift with the schema
// defaults. 316 is the geometric midpoint of 10..10000, so the log-curve
// target is exactly 0.1 + 0.5 * (0.95 - 0.1) = 0.525.
settings.set_double('als-min-lux', 10.0);
settings.set_double('als-max-lux', 10000.0);
mod.als.out = 'raw=316 scale=1.0 lux=316.0';
const impl3 = new mod.Impl(settings, '/nonexistent-extension-dir');
await impl3.enable();
await waitFor(() => manager._monitorScales.size === 1, 'impl3 inject');
const alsScale = manager._monitorScales.values().next().value;

async function tickUntil(cond, what) {
    const deadline = GLib.get_real_time() + 5 * GLib.TIME_SPAN_SECOND;
    while (!cond()) {
        if (GLib.get_real_time() > deadline)
            throw new Error(`timeout waiting for ${what}`);
        await impl3._alsTick();
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10,
            () => (r(), GLib.SOURCE_REMOVE)));
    }
}

const userUpdatesBefore = userUpdates;
const alsBefore = mod.alsCalls.length;
await tickUntil(() => Math.abs(alsScale.value - 0.525) < 0.002 &&
                    mod.alsCalls.length > alsBefore,
    'slider at curve target via a live sensor read');
ok(userUpdates === userUpdatesBefore, 'ALS moves emit no user-update (no OSD)');

// A user move while auto-brightness is on becomes a persistent offset.
alsScale.value = 0.8;
ok(userUpdates > userUpdatesBefore, 'slider move emits user-update');
nearly(settings.get_double('als-bias'), 0.8 - 0.525, 0.001,
    'user offset persisted to als-bias');
await impl3._alsTick();
nearly(alsScale.value, 0.8, 0.001, 'same light keeps the offset, no snap-back');

// Brighter room lifts the slider, carrying the offset.
mod.als.out = 'raw=10000 scale=1.0 lux=10000.0';
await tickUntil(() => alsScale.value > 0.9, 'slider follows bright light');

// Disabled: no reads, position held.
settings.set_boolean('auto-brightness', false);
const alsOffBefore = mod.alsCalls.length;
const held = alsScale.value;
await impl3._alsTick();
await impl3._alsTick();
ok(mod.alsCalls.length === alsOffBefore && alsScale.value === held,
    'disabled: no sensor reads');

// Re-enabled: re-anchors at the user's slider instead of jumping.
settings.set_boolean('auto-brightness', true);
await tickUntil(() => alsScale._alsTarget > 0.9, 'sensor re-read after re-enable');
nearly(alsScale.value, held, 1e-9, 're-activation keeps the slider where it was');
impl3.disable();
settings.set_double('als-bias', 0.0);
settings.set_boolean('auto-brightness', false);

// --- hot-reload re-import (the extension.js wrapper path) --------------------
/* The wrapper imports './impl.js?rev=<time>' on every enable: same URI,
 * different query. GTypes are per-process and derived from the file path
 * (query stripped), so an unsalted registerClass collides with the first
 * evaluation — the exact failure that wedged the extension in ERROR. */
try {
    const [a, b] = await reloadModuleTwice(IMPL_SRC);
    ok(a.StudioScale !== b.StudioScale && typeof b.Impl === 'function',
        're-import under the same file URI registers cleanly');
} catch (e) {
    ok(false, `re-import under the same file URI threw: ${e}`);
}

done('test-impl');
