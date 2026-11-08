/* Shared helpers for the studio-brightness test suites.
 *
 * The suites cannot import impl.js directly (it links against shell
 * resource:// modules), so we slice the testable classes out of the real
 * source file and evaluate them with stubs. This keeps the tests honest:
 * if impl.js is renamed or restructured, the loader fails loudly.
 */

import GLib from 'gi://GLib';

const root = GLib.getenv('ASD_ROOT');
if (!root)
    throw new Error('ASD_ROOT not set — run tests via tests/run-all.sh');

const bytes = GLib.file_get_contents(`${root}/extension/impl.js`)[1];
const src = new TextDecoder().decode(bytes);

function slice(re, what) {
    const m = src.match(re);
    if (!m)
        throw new Error(`could not find ${what} in extension/impl.js`);
    return m[0];
}

export const SLICES = {
    scaleSteps: slice(/const SCALE_VALUE_N_STEPS = \d+;[\s\S]*?const ALS_MIN_STEP = [\d.]+;/,
        'SCALE_VALUE_N_STEPS'),
    cliTimeout: slice(/const CLI_TIMEOUT_SECS = \d+;/, 'CLI_TIMEOUT_SECS'),
    spawn: slice(/function spawn\(argv\) \{[\s\S]*?\n\}/, 'spawn'),
    usbTarget: slice(/const UsbTarget = class \{[\s\S]*?\n\};/, 'UsbTarget'),
    studioScale: slice(
        /const TYPE_NS = [\s\S]*?const StudioScale = GObject\.registerClass\(\{[\s\S]*?\n\}\);/,
        'StudioScale'),
    impl: slice(/export class Impl \{[\s\S]*?\n\}/, 'Impl'),
};

/* Environment for the sliced code: GLib/Gio/GObject, shell logging
 * globals, gettext, and a stand-in for the shell's BrightnessScale base
 * class with a real GObject 'value' property so notify::value works. */
export const PREAMBLE = `
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
globalThis.log = m => print('LOG: ' + m);
globalThis.logError = e => print('ERR: ' + e);
globalThis._ = s => s;
globalThis.global ??= globalThis; /* shell realm alias */
/* gnome-shell patches GObject.Object.prototype with connectObject in
 * js/ui/environment.js; emulate it for standalone runs. */
GObject.Object.prototype.connectObject ??= function (...args) {
    if (args.at(-1) instanceof GObject.Object)
        args.pop(); // swapped data object
    const ids = [];
    for (let i = 0; i + 1 < args.length; i += 2)
        ids.push(this.connect(args[i], args[i + 1]));
    (this._connectedIds ??= []).push(...ids);
    return ids;
};
GObject.Object.prototype.disconnectObject ??= function () {
    for (const id of this._connectedIds ?? [])
        this.disconnect(id);
    this._connectedIds = [];
};
`;

export const BRIGHTNESS_SCALE_STUB = `
const BrightnessScale = GObject.registerClass({
    /* Same reason as StudioScale in impl.js: a module body may be evaluated
     * twice in one process (hot-reload simulation); GTypes are per-process,
     * so each evaluation needs a distinct type name. */
    GTypeName: 'AsdScaleStub_' + GLib.get_real_time().toString(36),
    Properties: {
        'value': GObject.ParamSpec.double(
            'value', '', '', GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class BrightnessScale extends GObject.Object {
    _init(name, value, nSteps) {
        this._name = name;
        this._value = value;
        this.nSteps = nSteps;
        super._init();
    }
    get name() {
        return this._name;
    }
    get value() {
        return this._value;
    }
    set value(v) {
        v = Math.min(Math.max(v, 0), 1);
        if (this._value === v)
            return;
        this._value = v;
        this.notify('value');
    }
    freeze() {}
    thaw() {}
    destroy() {}
    stepUp() {
        this.value = this.value + 1.0 / this.nSteps;
    }
    stepDown() {
        this.value = this.value - 1.0 / this.nSteps;
    }
});
`;

/* Evaluate module source in a fresh module record (cache-busted like the
 * extension's own wrapper). */
let count = 0;
export async function loadModule(body) {
    const path = `/tmp/opencode/gen-test-${count++}-${GLib.get_real_time()}.mjs`;
    GLib.file_set_contents(path, body);
    return import(`file://${path}?t=${GLib.get_real_time()}`);
}

/* Faithful simulation of the extension.js hot-reload wrapper: the very same
 * file URI imported twice with different cache-busting queries. GObject type
 * names are derived from the file path (queries stripped) and are per
 * process, so module bodies that registerClass must salt their type names. */
export async function reloadModuleTwice(body) {
    const path = `/tmp/opencode/gen-reload-${count++}-${GLib.get_real_time()}.mjs`;
    GLib.file_set_contents(path, body);
    const first = await import(`file://${path}?rev=1`);
    const second = await import(`file://${path}?rev=2`);
    return [first, second];
}

/* gjs runs the main context while the main module's top-level await is
 * pending, so tests simply await their promises; a manual MainLoop nested
 * in a TLA continuation would hang (its promise jobs never drain). */
export async function runMain(fn) {
    return await fn();
}

/* Tiny assertion harness: collect failures, report at the end. */
let failures = 0, checks = 0;

export function ok(cond, msg) {
    checks++;
    if (!cond) {
        failures++;
        log(`FAIL: ${msg}`);
    }
}

export function nearly(a, b, eps, msg) {
    ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ${b}±${eps})`);
}

export function done(suite) {
    if (failures) {
        log(`${failures}/${checks} FAILURES in ${suite}`);
        throw new Error(`${failures} failures`);
    }
    log(`${suite}: ALL ${checks} TESTS PASS`);
}
